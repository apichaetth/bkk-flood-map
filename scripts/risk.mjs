// ประมาณการถนนที่มีแนวโน้มน้ำท่วม (ทดลอง) — เรียกจาก update-data.mjs ทุก 15 นาที
//
// แนวคิด: ตัดถนนหลัก/รอง และซอยที่มีชื่อ (OpenStreetMap) เป็นช่วง ~150 ม. แล้วให้คะแนนแต่ละช่วงจาก
//   E  หลักฐานใกล้เคียง: เซ็นเซอร์ถนน กทม., รายงานน้ำท่วม (iTIC, Traffy, หมุดประชาชน, ข่าว) ยิ่งใกล้/ใหม่ ยิ่งมาก
//   R  ฝน: ฝนที่ตกแล้วจากสถานีรอบ ๆ (IDW) 1 ชม./24 ชม. รวมกับฝนพยากรณ์ 3 ชม. ข้างหน้า (กรมอุตุฯ)
//   H  ความเสี่ยงเดิม: จำนวนเรื่องน้ำท่วมใน Traffy ย้อนหลังรอบช่วงถนนนั้น (ท่วมซ้ำบ่อย)
//   W  น้ำในคลอง/แม่น้ำใกล้ล้นตลิ่ง
//   score = 1 − (1 − E) × (1 − R·(0.3 + 0.7·H)) × (1 − 0.5·W)
// เป็นการประมาณจากหลักฐานรอบข้าง ไม่ใช่แบบจำลองการไหลของน้ำ (ไม่มีข้อมูลท่อ/สถานีสูบ/ระดับถนนละเอียด)
//
// วัดความแม่น (evalUpdate): แต่ละรอบที่ครบ 3 ชม. ดูว่าช่วงถนนที่ทายไว้ มีรายงานน้ำท่วม "ใหม่" ภายใน 150 ม. หรือไม่
// แยกนับ "ทายล่วงหน้า" (ตอนทายยังไม่มีใครแจ้งแถวนั้น) และเทียบกับวิธีง่าย ๆ "ทายจุดที่ท่วมบ่อย" จำนวนเท่ากัน
// ส่วนการจับได้ (recall) นับรายงานแต่ละเรื่องครั้งเดียว แล้วแยกว่าอยู่บนถนนหลัก ในซอย หรือห่างจากถนนที่เรามี

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PARAMS = {
  segM: 150,
  evidenceRadiusM: 800, evidenceDecayM: 250,
  // รายงานที่อยู่ในซอย (หรือไม่อยู่ใกล้ถนนที่มีในระบบ เช่น ในหมู่บ้าน) น้ำมักท่วมเฉพาะจุด ตีวงแคบกว่า
  soiRadiusM: 300, soiDecayM: 120,
  ageDecayH: { bma: 1, itic: 2, traffy: 3, web: 3, news: 4 },
  srcWeight: { bma: 1.0, itic: 1.0, web: 0.8, traffy: 0.7, news: 0.6 },
  rainIdwKm: 6, fcIdwKm: 8, fcHours: 3,
  histRadiusM: 300, histExcludeH: 6, histSaturate: 10,
  wlRadiusM: 1000,
  // ควรระวังมาก / ควรระวัง (ระดับ 0.2–0.35 เดิมทายถูกแค่ ~6% จึงเลิกแสดง; ขยับจาก 0.6/0.35 เป็น 0.7/0.45 หลังเพิ่มซอย+คลองแล้วติดธง ~16% ของถนน)
  tiers: [[0.7, 3], [0.45, 2]],
  evalHorizonH: 3, evalHitM: 150, aheadLookH: 6, rawKeepH: 8, evalKeepDays: 30, roadNearM: 50,
};
export const ROADS_VER = 2; // เปลี่ยนเมื่อเปลี่ยนชุดถนนที่ดึง (v2 = เพิ่มซอยที่มีชื่อ)
const HW = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$';
const SOI = '^(residential|unclassified|living_street)$';
export const isMain = (cls) => /^(motorway|trunk|primary|secondary|tertiary)$/.test(cls);
const BBOX = [13.48, 100.32, 13.97, 100.95]; // s, w, n, e

// ---------- เรขาคณิต ----------
const R_EARTH = 6371000;
function distM(a, b, c, d) {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R_EARTH;
}
// ระยะ (ม.) จากจุดถึงเส้นถนน (ประมาณแบบระนาบ พอสำหรับระยะไม่กี่ร้อยเมตร)
function distToLine(la, lo, c) {
  const kx = Math.cos(la * Math.PI / 180) * 111320, ky = 110540;
  let best = Infinity;
  for (let i = 0; i < c.length; i++) {
    const ax = (c[i][1] - lo) * kx, ay = (c[i][0] - la) * ky;
    if (i === 0) { best = Math.hypot(ax, ay); continue; }
    const bx = (c[i - 1][1] - lo) * kx, by = (c[i - 1][0] - la) * ky, dx = ax - bx, dy = ay - by, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, -(bx * dx + by * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(bx + u * dx, by + u * dy));
  }
  return best;
}
// จุดนี้อยู่บนถนนแบบไหน: 'main' ถนนหลัก/รอง, 'soi' ซอย, 'off' ไม่มีถนนในระบบอยู่ใกล้ ๆ
function roadKind(segIdx, la, lo) {
  const P = PARAMS;
  let best = null;
  // หาจากจุดกลางช่วงในรัศมี roadNearM + ความยาวช่วง แล้ววัดระยะถึงตัวเส้นถนนจริง
  for (const s of near(segIdx, la, lo, P.roadNearM + P.segM)) {
    if (distM(la, lo, s.la, s.lo) > P.roadNearM + P.segM) continue;
    const dm = distToLine(la, lo, s.c);
    if (dm <= P.roadNearM && (!best || dm < best.dm)) best = { dm, s };
  }
  return !best ? 'off' : isMain(best.s.cls) ? 'main' : 'soi';
}
// ช่วงถนนที่ใกล้ที่สุดในรัศมี (ไว้ตั้งชื่อจุด)
function nearestSeg(segIdx, la, lo, maxM) {
  let best = null;
  for (const s of near(segIdx, la, lo, maxM)) { const d = distM(la, lo, s.la, s.lo); if (d <= maxM && (!best || d < best.d)) best = { d, s }; }
  return best && best.s;
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
    const fresh = old.ver === ROADS_VER && Date.now() - new Date(old.built) < 30 * 864e5;
    // สร้างใหม่ไม่สำเร็จเมื่อไม่นานมานี้: ใช้ชุดเก่าไปก่อน ไม่ถาม Overpass ทุก 15 นาที
    const backoff = old.retryAt && Date.now() - old.retryAt < 6 * 36e5;
    if (old.segments.length && (fresh || backoff)) return old;
  } catch { /* ยังไม่มี */ }
  log('building road segments from Overpass…');
  // ถนนหลัก/รอง ทั้งหมด + ซอยที่มีชื่อ (ซอยไม่มีชื่อส่วนใหญ่เป็นทางในหมู่บ้าน/โครงการ ข้ามไปเพื่อไม่ให้ไฟล์ใหญ่เกิน)
  // ซอยมีจำนวนมาก แบ่งถามทีละส่วน (3×3) ไม่ให้ Overpass ปฏิเสธเพราะคำขอใหญ่เกิน
  const [S, W, N, E] = BBOX, parts = [`way["highway"~"${HW}"](${BBOX.join(',')});`];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const s = S + ((N - S) * i) / 3, n = S + ((N - S) * (i + 1)) / 3, w = W + ((E - W) * j) / 3, e = W + ((E - W) * (j + 1)) / 3;
    parts.push(`way["highway"~"${SOI}"]["name"](${[s, w, n, e].map((v) => v.toFixed(4)).join(',')});`);
  }
  const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const t0 = Date.now(), seen = new Set(), data = { elements: [] };
  let failed = null;
  for (const part of parts) {
    const q = `[out:json][timeout:120];${part}out geom tags;`;
    let ok = false;
    for (const url of MIRRORS) {
      if (Date.now() - t0 > 8 * 6e4) break; // ไม่ให้รอบอัปเดตนานเกิน
      try {
        const d = JSON.parse(await fetchText(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 150000));
        if (d.remark && /error/i.test(d.remark)) throw new Error(d.remark.slice(0, 120));
        for (const w of d.elements || []) if (!seen.has(w.id)) { seen.add(w.id); data.elements.push(w); }
        ok = true; break;
      } catch (e) { log(`overpass ${new URL(url).host} failed:`, e.message); }
    }
    if (!ok) { failed = part; break; }
  }
  log(`overpass: ${data.elements.length} ways in ${Math.round((Date.now() - t0) / 1000)} s${failed ? ' (incomplete)' : ''}`);
  // สร้างใหม่ไม่ครบ: ใช้ชุดเก่าไปก่อน (ถนนแทบไม่เปลี่ยน) แล้วลองใหม่ภายหลัง
  if (failed) {
    if (old && old.segments && old.segments.length) {
      log('roads rebuild failed, using old file');
      old.retryAt = Date.now();
      await writeFile(file, JSON.stringify(old));
      return old;
    }
    throw new Error('overpass failed');
  }
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
  const out = { ver: ROADS_VER, built: new Date().toISOString(), count: segments.length, segments };
  await writeFile(file, JSON.stringify(out));
  log('road segments:', segments.length);
  return out;
}

// ---------- คะแนน ----------
// input: reports [{la,lo,t,src,lv?}], history [{la,lo,t}], rain [{la,lo,mm1,mm24}], wl [{la,lo,pct,name}], fc [{la,lo,mm}] (ฝนพยากรณ์ 3 ชม.)
// คืนช่วงถนนที่ติดระดับ (เรียงคะแนนมากไปน้อย) และ .hot = id ช่วงถนนที่ท่วมซ้ำบ่อยที่สุด (ไว้เป็นตัวเทียบ)
export function scoreRoads(roads, input, now = Date.now()) {
  const P = PARAMS;
  // รายงาน (หลักฐาน) และประวัติ
  const reports = input.reports.filter((r) => r.t <= now && now - r.t <= 24 * 36e5);
  // ประเภทตำแหน่งรายงาน: บนถนนหลัก/รอง = ตีวงกว้าง, ในซอยหรือห่างถนน = ตีวงแคบ
  const segIdx = gridIndex(roads.segments);
  for (const r of reports) {
    const k = roadKind(segIdx, r.la, r.lo);
    r.rad = k === 'main' ? P.evidenceRadiusM : P.soiRadiusM;
    r.decay = k === 'main' ? P.evidenceDecayM : P.soiDecayM;
  }
  const repIdx = gridIndex(reports);
  const hist = input.history.filter((h) => now - h.t > P.histExcludeH * 36e5);
  const histIdx = gridIndex(hist);
  const rain = input.rain, fc = input.fc || [];
  const wl = input.wl.filter((s) => s.pct != null);
  const out = [], hot = [];
  const idw = (list, la, lo, km, key) => {
    let sw = 0, sv = 0;
    for (const st of list) {
      const dk = distM(la, lo, st.la, st.lo) / 1000;
      if (dk > km) continue;
      const w = 1 / Math.max(0.3, dk) ** 2;
      sw += w; sv += w * (st[key] || 0);
    }
    return sw ? sv / sw : null;
  };
  for (const s of roads.segments) {
    // E: หลักฐานใกล้เคียง (รวมแบบความน่าจะเป็น)
    let notE = 1, bestE = null;
    for (const r of near(repIdx, s.la, s.lo, P.evidenceRadiusM)) {
      const d = distM(s.la, s.lo, r.la, r.lo);
      if (d > r.rad) continue;
      const ageH = (now - r.t) / 36e5;
      const w = P.srcWeight[r.src] * (r.lv ? Math.min(1, 0.5 + r.lv / 6) : 1) * Math.exp(-d / r.decay) * Math.exp(-ageH / P.ageDecayH[r.src]);
      notE *= 1 - Math.min(0.95, w);
      if (!bestE || w > bestE.w) bestE = { w, d: Math.round(d), src: r.src, ageMin: Math.round(ageH * 60) };
    }
    const E = 1 - notE;
    // R: ฝนที่ตกแล้ว (IDW จากสถานีในรัศมี) รวมกับฝนพยากรณ์ 3 ชม. ข้างหน้า
    const mm1 = idw(rain, s.la, s.lo, P.rainIdwKm, 'mm1') || 0, mm24 = idw(rain, s.la, s.lo, P.rainIdwKm, 'mm24') || 0;
    const mmF = idw(fc, s.la, s.lo, P.fcIdwKm, 'mm') || 0;
    const Ro = Math.min(1, mm1 / 30) * 0.6 + Math.min(1, mm24 / 90) * 0.4;
    const R = 1 - (1 - Ro) * (1 - 0.7 * Math.min(1, mmF / 30));
    // H: ท่วมซ้ำบ่อย
    let hc = 0;
    for (const h of near(histIdx, s.la, s.lo, P.histRadiusM)) if (distM(s.la, s.lo, h.la, h.lo) <= P.histRadiusM) hc++;
    const H = Math.min(1, Math.log1p(hc) / Math.log1p(P.histSaturate));
    if (hc) hot.push([hc, s.id]);
    // W: คลองใกล้ล้นตลิ่ง
    let W = 0, wlSt = null;
    for (const st of wl) {
      if (distM(s.la, s.lo, st.la, st.lo) > (st.r || P.wlRadiusM)) continue;
      // st.W = ค่าที่กำหนดมาแล้ว (คลอง กทม. ตามสถานะ) ไม่งั้นคิดจาก % ตลิ่ง
      const v = st.W ?? Math.max(0, Math.min(1, (st.pct - 80) / 20));
      if (v > W) { W = v; wlSt = st; }
    }
    const partR = R * (0.3 + 0.7 * H), partW = 0.5 * W;
    const score = 1 - (1 - E) * (1 - partR) * (1 - partW);
    const tier = (P.tiers.find(([th]) => score >= th) || [0, 0])[1];
    if (!tier) continue;
    // ปัจจัยหลักที่ทำให้ติดระดับ: 0 รายงาน/เซ็นเซอร์ใกล้เคียง, 1 ฝน (+ท่วมบ่อย), 2 น้ำในคลอง
    const drv = E >= partR && E >= partW ? 0 : partR >= partW ? 1 : 2;
    const SRCN = { bma: 'เซ็นเซอร์ถนน กทม.', itic: 'หน่วยงาน/iTIC', traffy: 'Traffy', web: 'ประชาชนปักหมุด', news: 'ข่าว' };
    const why = [];
    if (bestE && E >= 0.1) why.push(`มีรายงานน้ำท่วม (${SRCN[bestE.src]}) ห่าง ${bestE.d} ม. เมื่อ ${bestE.ageMin} นาทีที่แล้ว`);
    if (mm1 >= 5 || mm24 >= 20) why.push(`ฝนแถวนี้ประมาณ ${mm1.toFixed(0)} มม./ชม. · ${mm24.toFixed(0)} มม./24 ชม.`);
    if (mmF >= 3) why.push(`กรมอุตุฯ คาดฝนอีกราว ${mmF.toFixed(0)} มม. ใน ${P.fcHours} ชม. ข้างหน้า`);
    if (hc) why.push(`เคยมีคนแจ้งน้ำท่วมแถวนี้ ${hc} ครั้งในช่วงที่ผ่านมา`);
    if (wlSt) why.push(`ระดับน้ำ${wlSt.name ? ' ' + wlSt.name : ''} ${wlSt.pct.toFixed(0)}% ของตลิ่ง`);
    // x = เหตุผลแบบตัวเลข (หน้าเว็บสร้างข้อความเอง ไฟล์จะเล็กกว่าเก็บข้อความ)
    // [แหล่งรายงาน, ระยะ, อายุ(นาที), ฝน1ชม., ฝน24ชม., ท่วมบ่อย, %ตลิ่ง, สถานี, ฝนพยากรณ์]
    const x = [bestE && E >= 0.1 ? ['itic', 'traffy', 'web', 'news', 'bma'].indexOf(bestE.src) : -1, bestE ? bestE.d : 0, bestE ? bestE.ageMin : 0,
      mm1 >= 5 || mm24 >= 20 ? Math.round(mm1) : -1, Math.round(mm24), hc, wlSt ? Math.round(wlSt.pct) : -1, wlSt ? wlSt.name || '' : '',
      mmF >= 3 ? Math.round(mmF) : -1];
    out.push({ id: s.id, name: s.name, cls: s.cls, district: s.district, c: s.c, la: s.la, lo: s.lo, score: +score.toFixed(3), tier, drv,
      f: { E: +E.toFixed(2), R: +R.toFixed(2), H: +H.toFixed(2), W: +W.toFixed(2) }, why, x });
  }
  out.sort((a, b) => b.score - a.score);
  out.hot = hot.sort((a, b) => b[0] - a[0]).slice(0, 3000).map(([, id]) => id);
  return out;
}

// ---------- ไฟล์สำหรับหน้าเว็บแบบกะทัดรัด ----------
// s = [tier, คะแนน×100, ดัชนีชื่อถนน, ดัชนีเขต, พิกัด (จุดแรก ×1e5 แล้วต่อด้วยผลต่าง), เหตุผล x (ชื่อสถานีเป็นดัชนี)]
export function packSegments(segs) {
  const names = [], ni = new Map(), dists = [], di = new Map(), stns = [], si = new Map();
  const idx = (arr, m, v) => { if (!m.has(v)) { m.set(v, arr.length); arr.push(v); } return m.get(v); };
  const s = segs.map((g) => {
    const flat = []; let pa = 0, po = 0;
    for (const [a, o] of g.c) { const A = Math.round(a * 1e5), O = Math.round(o * 1e5); flat.push(A - pa, O - po); pa = A; po = O; }
    const x = g.x.slice(0, 7); x.push(g.x[7] ? idx(stns, si, g.x[7]) : -1, g.x[8] ?? -1);
    return [g.tier, Math.round(g.score * 100), idx(names, ni, g.name || ''), idx(dists, di, g.district || ''), flat, x];
  });
  return { v: 2, names, districts: dists, stations: stns, s };
}

// ---------- วัดความแม่น ----------
// state (เก็บใน risk-history.json ข้ามรอบ):
//   runs: ผลการทายดิบ [{ t, rb, segs: [[id, tier, drv]], base: [id] }] เก็บไว้ rawKeepH ชม.
//   days: สถิติรายวัน (เวลาไทย) เก็บ evalKeepDays วัน  ·  seen: รายงานที่นับการจับได้ไปแล้ว
// reports = รายงานน้ำท่วมจริงที่ใช้ตรวจ (ไม่ซ้ำกัน ไม่รวมข่าว) [{ la, lo, t, src }]
const dayOf = (t) => new Date(t + 7 * 36e5).toISOString().slice(0, 10);
const emptyDay = () => ({ runs: 0, rain: 0, t: { 3: [0, 0, 0, 0], 2: [0, 0, 0, 0] }, base: [0, 0], drv: [[0, 0], [0, 0], [0, 0]], rec: { main: [0, 0, 0], soi: [0, 0, 0], off: [0, 0, 0] } });
export function newEvalState(old) {
  // รูปแบบเดิม (อาร์เรย์ของรอบ) ใช้ id ถนนชุดเก่า ตรวจต่อไม่ได้ เริ่มนับใหม่
  if (!old || Array.isArray(old) || old.v !== 3) return { v: 3, runs: [], days: {}, seen: {} };
  return old;
}
export function evalUpdate(state, roads, reports, now = Date.now()) {
  const P = PARAMS, H = P.evalHorizonH * 36e5;
  const segById = new Map(roads.segments.map((s) => [s.id, s]));
  const segIdx = gridIndex(roads.segments);
  const idx = gridIndex(reports);
  const hitNear = (s, from, to) => near(idx, s.la, s.lo, P.evalHitM).some((r) => r.t > from && r.t <= to && distM(s.la, s.lo, r.la, r.lo) <= P.evalHitM);
  const day = (t) => (state.days[dayOf(t)] ||= emptyDay());
  // 1) ความแม่น: รอบที่ครบ 3 ชม. แล้วและยังไม่ได้ตรวจ
  for (const run of state.runs) {
    if (run.done || run.t + H > now) continue;
    run.done = true;
    if (run.rb !== roads.built) continue; // ชุดถนนเปลี่ยน id ไม่ตรงกันแล้ว
    const d = day(run.t);
    d.runs++; d.rain = Math.max(d.rain, run.rain || 0);
    for (const [id, tier, drv] of run.segs) {
      const s = segById.get(id); if (!s || !d.t[tier]) continue;
      const hit = hitNear(s, run.t, run.t + H);
      // "ทายล่วงหน้า" = ตอนทายยังไม่มีรายงานแถวนั้นใน 6 ชม. ก่อนหน้า
      const ahead = !hitNear(s, run.t - P.aheadLookH * 36e5, run.t);
      const c = d.t[tier];
      c[0]++; if (hit) c[1]++;
      if (ahead) { c[2]++; if (hit) c[3]++; }
      if (tier === 3) { d.drv[drv][0]++; if (hit) d.drv[drv][1]++; }
    }
    for (const id of run.base || []) { const s = segById.get(id); if (!s) continue; d.base[0]++; if (hitNear(s, run.t, run.t + H)) d.base[1]++; }
  }
  // 2) การจับได้: รายงานแต่ละเรื่องนับครั้งเดียว ต้องมีผลการทายครบช่วง 3 ชม. ก่อนหน้าเก็บอยู่
  const runs = state.runs.filter((r) => r.rb === roads.built);
  const oldest = runs.length ? runs[0].t : Infinity;
  for (const r of reports) {
    if (r.t > now || r.t < oldest + H) continue;
    const key = r.src + ':' + r.la.toFixed(4) + ',' + r.lo.toFixed(4) + '@' + r.t;
    if (state.seen[key]) continue;
    const before = runs.filter((h) => h.t < r.t && h.t >= r.t - H);
    if (!before.length) continue;
    state.seen[key] = r.t;
    const kind = roadKind(segIdx, r.la, r.lo);
    let caught = 0;
    for (const h of before) for (const [id, tier] of h.segs) {
      const s = segById.get(id);
      if (s && distM(r.la, r.lo, s.la, s.lo) <= P.evalHitM) { caught = Math.max(caught, tier); if (caught === 3) break; }
    }
    const c = day(r.t).rec[kind];
    c[0]++; if (caught) c[1]++; if (caught === 3) c[2]++;
    // เก็บจุดที่พลาด (ท่วมจริงแต่ไม่ได้ทายไว้) ไว้ดูว่าพลาดที่ไหนบ่อย
    if (!caught) {
      const s = nearestSeg(segIdx, r.la, r.lo, 400);
      (state.miss ||= []).push([r.t, (s && s.name) || '', (s && s.district) || '', kind]);
    }
  }
  // เก็บกวาด
  state.runs = state.runs.filter((r) => now - r.t <= P.rawKeepH * 36e5);
  for (const [k, t] of Object.entries(state.seen)) if (now - t > (P.rawKeepH + 1) * 36e5) delete state.seen[k];
  if (state.miss) state.miss = state.miss.filter(([t]) => now - t <= 7 * 864e5);
  const keep = dayOf(now - P.evalKeepDays * 864e5);
  for (const k of Object.keys(state.days)) if (k < keep) delete state.days[k];
  return summarize(state);
}
// สรุปสำหรับหน้าเว็บ: รวมทั้งช่วง + รายวัน
function summarize(state) {
  const total = emptyDay();
  const add = (a, b) => b.forEach((v, i) => { a[i] += v; });
  const days = Object.keys(state.days).sort().reverse().map((k) => {
    const d = state.days[k];
    total.runs += d.runs; total.rain = Math.max(total.rain, d.rain);
    add(total.t[3], d.t[3]); add(total.t[2], d.t[2]); add(total.base, d.base);
    d.drv.forEach((v, i) => add(total.drv[i], v));
    for (const kind of ['main', 'soi', 'off']) add(total.rec[kind], d.rec[kind]);
    return { d: k, ...d };
  });
  // จุดที่พลาดบ่อยใน 7 วัน (รวมตามชื่อถนน + เขต)
  const g = new Map();
  for (const [, name, district, kind] of state.miss || []) {
    const k = (name || 'ถนน/ซอยไม่มีชื่อ') + '|' + district;
    const o = g.get(k) || { name: name || 'ถนน/ซอยไม่มีชื่อ', district, n: 0, kinds: {} };
    o.n++; o.kinds[kind] = (o.kinds[kind] || 0) + 1; g.set(k, o);
  }
  const missTop = [...g.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  return { v: 3, horizonH: PARAMS.evalHorizonH, hitM: PARAMS.evalHitM, aheadH: PARAMS.aheadLookH, total, days, missTop, miss7: (state.miss || []).length };
}
