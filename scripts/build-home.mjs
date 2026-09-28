// สรุปจุดน้ำท่วมทั้งเมืองไว้ล่วงหน้า (data/home.json) ให้หน้าแรกโหลดไฟล์เดียวเล็ก ๆ แทนการดึง 7 แหล่ง ~4 MB
// ใช้โค้ดเดียวกับหน้าเว็บ (js/core.js + js/agg.js) รันใน Node ผลจึงตรงกับที่เบราว์เซอร์คำนวณเอง
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.env.HOME_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const log = (...a) => console.log('[home]', ...a);

// fetch สำหรับโค้ดหน้าเว็บ: data/... อ่านจากไฟล์ในเครื่อง ส่วน https ใช้ fetch จริง
async function pageFetch(url, opts = {}) {
  const u = String(url);
  if (/^https?:/.test(u)) return fetch(u, opts);
  const f = path.join(ROOT, u.split('?')[0]);
  try {
    const body = await readFile(f);
    return new Response(body, { status: 200 });
  } catch { return new Response('not found', { status: 404 }); }
}
const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => null });
const documentStub = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: {}, body: stub, createElement: () => stub };
const window = {};
const ctx = vm.createContext({
  window, document: documentStub, navigator: {}, location: { protocol: 'http:', pathname: '/build', search: '', hash: '' },
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  fetch: pageFetch, AbortController, setTimeout, clearTimeout, setInterval: () => 0, console, Date, Intl, Math, JSON, URL, URLSearchParams,
  Response, getComputedStyle: () => ({ getPropertyValue: () => '' }), alert() {},
});
ctx.window = ctx; // โค้ดหน้าเว็บอ้าง window.X และ X สลับกัน
for (const f of ['js/core.js', 'js/agg.js']) vm.runInContext(await readFile(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const F = ctx.Flood, A = ctx.FloodAgg;

const FEEDS = [['sensor', 'fetchSensors'], ['event', 'fetchEvents'], ['traffy', 'fetchTraffy'], ['rain', 'fetchRain'], ['wl', 'fetchWl'], ['news', 'fetchNews'], ['web', 'fetchWebReports']];
const D = {}, feeds = {};
await Promise.all(FEEDS.map(async ([k, fn]) => {
  try { const r = await F[fn](); D[k] = r.items; feeds[k] = { ok: true, n: r.items.length, newest: r.newest ? new Date(r.newest).toISOString() : null }; }
  catch (e) { D[k] = null; feeds[k] = { ok: false, error: String(e.message || e).slice(0, 120) }; }
}));
const geo = await F.loadDistricts().catch(() => null);
const clusters = A.cluster(A.signals(D), geo);
const dists = A.byDistrict(clusters, D.news);
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const ms = (t) => (t ? new Date(t).getTime() : null);
const out = {
  updated: new Date().toISOString(), feeds,
  // จุด: [lat, lng, ระดับ, ชื่อ, เขต, ซม., เวลาล่าสุด(ms), แหล่ง[], จำนวนรายงาน, รายละเอียด 3 รายการ [แหล่ง, ข้อความ, เวลา, ลิงก์]]
  c: clusters.map((c) => [r5(c.la), r5(c.lo), c.tier, c.name, c.district || '', Math.round(c.cm || 0), ms(c.t), c.sources, c.members.length,
    c.tier >= 2 ? c.members.filter((m) => m.tier >= 2).slice(0, 3).map((m) => [m.src, String(m.detail || '').slice(0, 120), ms(m.t), m.link || '']) : []]),
  d: dists.map((d) => [d.name, d.level, d[3], d[2], d[1], d.news]),
  // รายงานรายจุด (ไม่รวมกลุ่ม) สำหรับ "รอบตัวฉัน": [lat, lng, แหล่ง, เวลา(ms), ซม., ชื่อ, รายละเอียด, ลิงก์, ระดับ]
  m: (() => {
    const seen = new Set(), out = [];
    for (const c of clusters) for (const x of c.members) {
      if (x.tier < 2) continue;
      const k = x.src + r5(x.la) + ',' + r5(x.lo) + '@' + ms(x.t);
      if (seen.has(k)) continue; seen.add(k);
      out.push([r5(x.la), r5(x.lo), x.src, ms(x.t), Math.round(x.cm || 0), String(x.name || '').slice(0, 80), String(x.detail || '').slice(0, 100), x.link || '', x.tier]);
    }
    return out;
  })(),
};
// ---------- สถานการณ์รายเขต: สีจากรายงาน 3 ชม. ล่าสุด + แนวโน้ม (ดีขึ้น/ทรงตัว/แย่ลง) จากหลายสัญญาณ ----------
// [เขต, ระดับ(-1 = มีแต่รายงานเก่า, 0–3), รายงาน 3 ชม., จุดยืนยัน, ลึกสุด ซม., รายงานเก่า 3–24 ชม., แนวโน้ม(1 แย่ลง/0 ทรงตัว/-1 ดีขึ้น/null), เหตุผล[]]
if (geo) {
  const now = Date.now(), H1 = 36e5;
  const Z = new Map(geo.features.map((f) => [f.properties.name, { fresh: 0, conf: 0, max: 0, old: 0, old6: 0, a1: 0, a2: 0, sen: 0, senN: 0, rain: 0, rainN: 0, wet: 0 }]));
  const zOf = (la, lo) => Z.get(F.districtAt(geo, la, lo));
  for (const x of out.m) {
    const z = zOf(x[0], x[1]); if (!z || !x[3]) continue;
    const age = now - x[3];
    if (age <= 3 * H1) { z.fresh++; z.max = Math.max(z.max, x[4] || 0); if (age <= H1) z.a1++; else if (age <= 2 * H1) z.a2++; }
    else if (age <= 24 * H1) { z.old++; if (age <= 6 * H1) z.old6++; }
  }
  for (const c of clusters) if (c.tier === 3 && c.t && now - new Date(c.t) <= 3 * H1) { const z = zOf(c.la, c.lo); if (z) z.conf++; }
  const V = { fast: 2, up: 1, peak: 0, flat: 0, down: -1, dfast: -2 };
  let tr = null;
  try { tr = JSON.parse(await readFile(path.join(DATA, 'trends.json'), 'utf8')); if (now - new Date(tr.updated) > 90 * 6e4) tr = null; } catch { tr = null; }
  for (const x of tr ? [...(tr.road || []), ...(tr.canal || [])] : []) { const z = zOf(x.la, x.lo); if (z && x.tr in V) { z.sen += V[x.tr]; z.senN++; } }
  for (const x of tr ? tr.rain || [] : []) { const z = zOf(x.la, x.lo); if (z && x.tr in V) { z.rain += V[x.tr]; z.rainN++; } }
  for (const r of D.rain || []) if (r.mm1 >= 5 && Date.now() - r.t <= 2 * H1) { const z = zOf(r.la, r.lo); if (z) z.wet++; }
  const sg = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  out.z = [...Z.entries()].map(([n, z]) => {
    // แดง = ยืนยันแล้ว ≥ 3 จุด หรือน้ำลึก ≥ 30 ซม. และมีรายงาน ≥ 3 เรื่อง · ส้ม = รายงาน ≥ 3 เรื่อง หรือ ≥ 10 ซม. หรือยืนยัน 1 จุด · เหลือง = มีรายงานบ้าง
    const lv = z.fresh ? (z.conf >= 3 || (z.max >= 30 && z.fresh >= 3) ? 3 : z.fresh >= 3 || z.max >= 10 || z.conf >= 1 ? 2 : 1) : z.old ? -1 : 0;
    const why = [];
    let rep = 0;
    // เปลี่ยนชัดเจน: ต่างกันเกิน 1 เรื่อง และเกิน ~30% (เขตที่มีรายงานมาก 24 กับ 21 ถือว่าพอ ๆ กัน)
    if (z.a1 + z.a2 >= 2 && z.a1 > z.a2 * 1.3 + 1) { rep = 1; why.push(`รายงานใหม่เพิ่มขึ้น (ชม.ล่าสุด ${z.a1} · ชม.ก่อน ${z.a2})`); }
    else if (z.a1 + z.a2 >= 2 && z.a2 > z.a1 * 1.3 + 1) { rep = -1; why.push(`รายงานใหม่ลดลง (ชม.ล่าสุด ${z.a1} · ชม.ก่อน ${z.a2})`); }
    else if (!z.fresh && z.old6) { rep = -1; why.push(`ไม่มีรายงานใหม่ใน 3 ชม. (ก่อนหน้านั้นมี ${z.old6} เรื่อง)`); }
    const sen = sg(z.sen);
    if (z.senN && sen > 0) why.push(`เซ็นเซอร์ถนน/คลองระดับน้ำเพิ่มขึ้น`); else if (z.senN && sen < 0) why.push(`เซ็นเซอร์ถนน/คลองระดับน้ำลดลง`);
    let rn = sg(z.rain) || (z.wet ? 1 : 0);
    if (rn > 0) why.push(z.wet ? 'ฝนกำลังตกหนัก (≥ 5 มม./ชม.)' : 'ฝนแรงขึ้น'); else if (rn < 0) why.push('ฝนเบาลง');
    const has = z.fresh || z.old6 || z.senN || z.rainN || z.wet;
    const sum = rep + sen + rn;
    return [n, lv, z.fresh, z.conf, z.max, z.old, has ? sg(sum) : null, why];
  });
}
await writeFile(path.join(DATA, 'home.json'), JSON.stringify(out));
log(`districts w/ status ${(out.z || []).filter((z) => z[1]).length} · clusters ${clusters.length} (tier3 ${clusters.filter((c) => c.tier === 3).length}, tier2 ${clusters.filter((c) => c.tier === 2).length}) · districts ${dists.length} · feeds`,
  Object.entries(feeds).map(([k, v]) => `${k}:${v.ok ? v.n : 'FAIL'}`).join(' '));
