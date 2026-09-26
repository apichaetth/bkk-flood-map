// ประมาณการถนนที่มีแนวโน้มน้ำท่วม (ทดลอง) — เรียกจาก update-data.mjs ทุก 15 นาที
//
// แนวคิด: ตัดถนนหลัก/รอง (OpenStreetMap) เป็นช่วง ~150 ม. แล้วให้คะแนนแต่ละช่วงจาก
//   E  หลักฐานใกล้เคียง: รายงานน้ำท่วม (iTIC, Traffy, หมุดประชาชน, ข่าว) ยิ่งใกล้/ใหม่ ยิ่งมาก
//   R  ฝน: ประมาณจากสถานีฝนรอบ ๆ (IDW) ทั้ง 1 ชม. และ 24 ชม.
//   H  ความเสี่ยงเดิม: จำนวนเรื่องน้ำท่วมใน Traffy ย้อนหลังรอบช่วงถนนนั้น (ท่วมซ้ำบ่อย)
//   W  น้ำในคลอง/แม่น้ำใกล้ล้นตลิ่ง
//   score = 1 − (1 − E) × (1 − R·(0.3 + 0.7·H)) × (1 − 0.5·W)
// เป็นการประมาณจากหลักฐานรอบข้าง ไม่ใช่แบบจำลองการไหลของน้ำ (ไม่มีข้อมูลท่อ/สถานีสูบ/ระดับถนนละเอียด)
//
// วัดความแม่น: เก็บผลทุกรอบ แล้วดูว่าช่วงถนนที่ทายไว้ มีรายงานน้ำท่วม "ใหม่" ภายใน 150 ม. ใน 3 ชม. ถัดมาหรือไม่

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PARAMS = {
  segM: 150,
  evidenceRadiusM: 800, evidenceDecayM: 250,
  ageDecayH: { itic: 2, traffy: 3, web: 3, news: 4 },
  srcWeight: { itic: 1.0, web: 0.8, traffy: 0.7, news: 0.6 },
  rainIdwKm: 6,
  histRadiusM: 300, histExcludeH: 6, histSaturate: 10,
  wlRadiusM: 1000,
  tiers: [[0.6, 3], [0.35, 2], [0.2, 1]], // สูง / กลาง / เฝ้าระวัง
  evalHorizonH: 3, evalHitM: 150, historyKeepH: 72,
};
const TIER_NAME = { 3: 'สูง', 2: 'กลาง', 1: 'เฝ้าระวัง' };
const HW = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$';
const BBOX = [13.48, 100.32, 13.97, 100.95]; // s, w, n, e

// ---------- เรขาคณิต ----------
const R_EARTH = 6371000;
function distM(a, b, c, d) {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R_EARTH;
}
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function districtAt(geo, lat, lng) {
  for (const f of geo.features) for (const poly of f.geometry.coordinates) if (inRing(lng, lat, poly[0])) return f.properties.name;
  return '';
}
// ตารางช่อง ~500 ม. ไว้หาของใกล้เคียงเร็ว ๆ
const CELL = 0.0045;
const cellKey = (la, lo) => Math.floor(la / CELL) + ':' + Math.floor(lo / CELL);
function gridIndex(items) {
  const g = new Map();
  for (const it of items) { const k = cellKey(it.la, it.lo); if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
  return g;
}
function near(g, la, lo, radiusM) {
  const n = Math.ceil(radiusM / 480), ci = Math.floor(la / CELL), cj = Math.floor(lo / CELL), out = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) { const a = g.get((ci + i) + ':' + (cj + j)); if (a) out.push(...a); }
  return out;
}

// ---------- เครือข่ายถนน (ดึงจาก Overpass ครั้งเดียว เก็บไว้ 30 วัน) ----------
export async function loadRoads(DATA, fetchText, log) {
  const file = path.join(DATA, 'roads.json');
  let old = null;
  try {
    old = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - new Date(old.built) < 30 * 864e5 && old.segments.length) return old;
  } catch { /* ยังไม่มี */ }
  log('building road segments from Overpass…');
  const q = `[out:json][timeout:120];way["highway"~"${HW}"](${BBOX.join(',')});out geom tags;`;
  let data = null, lastErr = null;
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { data = JSON.parse(await fetchText(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 180000)); break; }
    catch (e) { lastErr = e; }
  }
  // สร้างใหม่ไม่สำเร็จ: ใช้ชุดเก่าไปก่อน (ถนนแทบไม่เปลี่ยน) แล้วลองใหม่รอบถัดไป
  if (!data) { if (old && old.segments && old.segments.length) { log('roads rebuild failed, using old file'); return old; } throw lastErr || new Error('overpass failed'); }
  const geo = JSON.parse(await readFile(path.join(DATA, 'districts.geojson'), 'utf8'));
  const segments = [];
  for (const w of data.elements || []) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const name = (w.tags && (w.tags['name:th'] || w.tags.name)) || '';
    const cls = String(w.tags && w.tags.highway || '').replace('_link', '');
    // ตัดเป็นช่วง ~150 ม.
    let cur = [[w.geometry[0].lat, w.geometry[0].lon]], len = 0;
    const flush = () => {
      if (cur.length < 2) return;
      const mid = cur[Math.floor(cur.length / 2)];
      const la = (cur[0][0] + cur[cur.length - 1][0] + mid[0]) / 3, lo = (cur[0][1] + cur[cur.length - 1][1] + mid[1]) / 3;
      const district = districtAt(geo, la, lo);
      if (district) segments.push({ id: segments.length, name, cls, district, la: +la.toFixed(5), lo: +lo.toFixed(5), c: cur.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]) });
    };
    for (let i = 1; i < w.geometry.length; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      let d = distM(a.lat, a.lon, b.lat, b.lon);
      // จุดห่างกันมาก (ถนนตรงยาว) แทรกจุดให้ตัดช่วงได้
      const steps = Math.max(1, Math.ceil(d / PARAMS.segM));
      for (let k = 1; k <= steps; k++) {
        const p = [a.lat + ((b.lat - a.lat) * k) / steps, a.lon + ((b.lon - a.lon) * k) / steps];
        cur.push(p); len += d / steps;
        if (len >= PARAMS.segM) { flush(); cur = [p]; len = 0; }
      }
    }
    flush();
  }
  const out = { built: new Date().toISOString(), count: segments.length, segments };
  await writeFile(file, JSON.stringify(out));
  log('road segments:', segments.length);
  return out;
}

// ---------- คะแนน ----------
export function scoreRoads(roads, input, now = Date.now()) {
  const P = PARAMS;
  // รายงาน (หลักฐาน) และประวัติ
  const reports = input.reports.filter((r) => r.t <= now && now - r.t <= 24 * 36e5);
  const repIdx = gridIndex(reports);
  const hist = input.history.filter((h) => now - h.t > P.histExcludeH * 36e5);
  const histIdx = gridIndex(hist);
  const rain = input.rain;
  const wl = input.wl.filter((s) => s.pct != null);
  const out = [];
  for (const s of roads.segments) {
    // E: หลักฐานใกล้เคียง (รวมแบบความน่าจะเป็น)
    let notE = 1, bestE = null;
    for (const r of near(repIdx, s.la, s.lo, P.evidenceRadiusM)) {
      const d = distM(s.la, s.lo, r.la, r.lo);
      if (d > P.evidenceRadiusM) continue;
      const ageH = (now - r.t) / 36e5;
      const w = P.srcWeight[r.src] * (r.lv ? Math.min(1, 0.5 + r.lv / 6) : 1) * Math.exp(-d / P.evidenceDecayM) * Math.exp(-ageH / P.ageDecayH[r.src]);
      notE *= 1 - Math.min(0.95, w);
      if (!bestE || w > bestE.w) bestE = { w, d: Math.round(d), src: r.src, ageMin: Math.round(ageH * 60) };
    }
    const E = 1 - notE;
    // R: ฝนแบบ IDW จากสถานีในรัศมี
    let sw = 0, s1 = 0, s24 = 0;
    for (const st of rain) {
      const dk = distM(s.la, s.lo, st.la, st.lo) / 1000;
      if (dk > P.rainIdwKm) continue;
      const w = 1 / Math.max(0.3, dk) ** 2;
      sw += w; s1 += w * (st.mm1 || 0); s24 += w * (st.mm24 || 0);
    }
    const mm1 = sw ? s1 / sw : 0, mm24 = sw ? s24 / sw : 0;
    const R = Math.min(1, mm1 / 30) * 0.6 + Math.min(1, mm24 / 90) * 0.4;
    // H: ท่วมซ้ำบ่อย
    let hc = 0;
    for (const h of near(histIdx, s.la, s.lo, P.histRadiusM)) if (distM(s.la, s.lo, h.la, h.lo) <= P.histRadiusM) hc++;
    const H = Math.min(1, Math.log1p(hc) / Math.log1p(P.histSaturate));
    // W: คลองใกล้ล้นตลิ่ง
    let W = 0, wlSt = null;
    for (const st of wl) {
      if (distM(s.la, s.lo, st.la, st.lo) > P.wlRadiusM) continue;
      const v = Math.max(0, Math.min(1, (st.pct - 80) / 20));
      if (v > W) { W = v; wlSt = st; }
    }
    const score = 1 - (1 - E) * (1 - R * (0.3 + 0.7 * H)) * (1 - 0.5 * W);
    const tier = (P.tiers.find(([th]) => score >= th) || [0, 0])[1];
    if (!tier) continue;
    const why = [];
    if (bestE && E >= 0.1) why.push(`มีรายงานน้ำท่วม (${{ itic: 'หน่วยงาน/iTIC', traffy: 'Traffy', web: 'ประชาชนปักหมุด', news: 'ข่าว' }[bestE.src]}) ห่าง ${bestE.d} ม. เมื่อ ${bestE.ageMin} นาทีที่แล้ว`);
    if (mm1 >= 5 || mm24 >= 20) why.push(`ฝนแถวนี้ประมาณ ${mm1.toFixed(0)} มม./ชม. · ${mm24.toFixed(0)} มม./24 ชม.`);
    if (hc) why.push(`เคยมีคนแจ้งน้ำท่วมแถวนี้ ${hc} ครั้งในช่วงที่ผ่านมา`);
    if (wlSt) why.push(`ระดับน้ำ${wlSt.name ? ' ' + wlSt.name : ''} ${wlSt.pct.toFixed(0)}% ของตลิ่ง`);
    // x = เหตุผลแบบตัวเลข (หน้าเว็บสร้างข้อความเอง ไฟล์จะเล็กกว่าเก็บข้อความ)
    const x = [bestE && E >= 0.1 ? ['itic', 'traffy', 'web', 'news'].indexOf(bestE.src) : -1, bestE ? bestE.d : 0, bestE ? bestE.ageMin : 0,
      mm1 >= 5 || mm24 >= 20 ? Math.round(mm1) : -1, Math.round(mm24), hc, wlSt ? Math.round(wlSt.pct) : -1, wlSt ? wlSt.name || '' : ''];
    out.push({ id: s.id, name: s.name, cls: s.cls, district: s.district, c: s.c, la: s.la, lo: s.lo, score: +score.toFixed(3), tier,
      f: { E: +E.toFixed(2), R: +R.toFixed(2), H: +H.toFixed(2), W: +W.toFixed(2) }, why, x });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- ไฟล์สำหรับหน้าเว็บแบบกะทัดรัด ----------
// s = [tier, คะแนน×100, ดัชนีชื่อถนน, ดัชนีเขต, พิกัด (จุดแรก ×1e5 แล้วต่อด้วยผลต่าง), เหตุผล x (ชื่อสถานีเป็นดัชนี)]
export function packSegments(segs) {
  const names = [], ni = new Map(), dists = [], di = new Map(), stns = [], si = new Map();
  const idx = (arr, m, v) => { if (!m.has(v)) { m.set(v, arr.length); arr.push(v); } return m.get(v); };
  const s = segs.map((g) => {
    const flat = []; let pa = 0, po = 0;
    for (const [a, o] of g.c) { const A = Math.round(a * 1e5), O = Math.round(o * 1e5); flat.push(A - pa, O - po); pa = A; po = O; }
    const x = g.x.slice(0, 7); x.push(g.x[7] ? idx(stns, si, g.x[7]) : -1);
    return [g.tier, Math.round(g.score * 100), idx(names, ni, g.name || ''), idx(dists, di, g.district || ''), flat, x];
  });
  return { v: 2, names, districts: dists, stations: stns, s };
}

// ---------- วัดความแม่น ----------
// history = [{ t, segs: [[id, tier], ...] }]
export function evaluate(history, roads, reports, now = Date.now()) {
  const P = PARAMS;
  const segById = new Map(roads.segments.map((s) => [s.id, s]));
  const idx = gridIndex(reports);
  const byTier = { 1: { n: 0, hit: 0 }, 2: { n: 0, hit: 0 }, 3: { n: 0, hit: 0 } };
  let runs = 0, newReports = 0, caught = 0;
  for (const h of history) {
    const end = h.t + P.evalHorizonH * 36e5;
    if (end > now) continue; // ยังไม่ครบเวลาประเมิน
    runs++;
    const fresh = reports.filter((r) => r.t > h.t && r.t <= end);
    newReports += fresh.length;
    const predicted = h.segs.map(([id, tier]) => ({ s: segById.get(id), tier })).filter((x) => x.s);
    for (const { s, tier } of predicted) {
      byTier[tier].n++;
      if (near(idx, s.la, s.lo, P.evalHitM).some((r) => r.t > h.t && r.t <= end && distM(s.la, s.lo, r.la, r.lo) <= P.evalHitM)) byTier[tier].hit++;
    }
    for (const r of fresh) if (predicted.some(({ s }) => distM(s.la, s.lo, r.la, r.lo) <= P.evalHitM)) caught++;
  }
  const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  return {
    runs, horizonH: P.evalHorizonH, hitM: P.evalHitM,
    precision: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [TIER_NAME[k], { predicted: v.n, hit: v.hit, pct: pct(v.hit, v.n) }])),
    recall: { newReports, caught, pct: pct(caught, newReports) },
  };
}
