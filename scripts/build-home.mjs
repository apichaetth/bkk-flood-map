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
};
await writeFile(path.join(DATA, 'home.json'), JSON.stringify(out));
log(`clusters ${clusters.length} (tier3 ${clusters.filter((c) => c.tier === 3).length}, tier2 ${clusters.filter((c) => c.tier === 2).length}) · districts ${dists.length} · feeds`,
  Object.entries(feeds).map(([k, v]) => `${k}:${v.ok ? v.n : 'FAIL'}`).join(' '));
