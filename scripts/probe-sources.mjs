// สำรวจแหล่งข้อมูลใหม่จาก GitHub Actions (รันเมื่อแก้ไฟล์นี้ หรือกดรันเอง) พิมพ์สถานะ โครงสร้าง และตัวอย่าง
const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const TWH = { Referer: 'https://www.thaiwater.net/' };
const shape = (v, d = 0) => {
  if (Array.isArray(v)) return `[${v.length}] ` + (v.length ? shape(v[0], d + 1) : '');
  if (v && typeof v === 'object') return '{' + Object.entries(v).slice(0, 40).map(([k, x]) => k + (d > 2 ? '' : ':' + shape(x, d + 1))).join(', ') + '}';
  return JSON.stringify(v)?.slice(0, 50);
};
async function probe(label, url, headers = {}) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (bkk-flood-map probe)', ...headers }, signal: ctl.signal });
    const txt = await r.text(); clearTimeout(tm);
    console.log(`\n### ${label}\n${r.status} ${r.headers.get('content-type')} ${txt.length} bytes ${Date.now() - t0} ms  ${url}`);
    try {
      const j = JSON.parse(txt);
      console.log('shape:', shape(j).slice(0, 1500));
      const arr = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : j.data && Array.isArray(j.data.data) ? j.data.data : null;
      if (arr) console.log('sample:', JSON.stringify(arr.slice(0, 2)).slice(0, 1800));
      return j;
    } catch { console.log('text:', txt.slice(0, 1500)); return txt; }
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message} ${url}`); return null; }
}
// ความแม่นจริงบนเว็บ: การจับได้ (recall) และจุดที่พลาดบ่อย
{
  const j = await fetch('https://apichaetth.github.io/bkk-flood-map/data/risk-roads.json?t=' + Date.now()).then((r) => r.json());
  const a = j.accuracy || {};
  console.log('updated', j.updated, 'counts', JSON.stringify(j.counts));
  console.log('total.rec', JSON.stringify(a.total && a.total.rec), 'runs', a.total && a.total.runs, 't3', JSON.stringify(a.total && a.total.t[3]), 'base', JSON.stringify(a.total && a.total.base));
  for (const d of a.days || []) console.log('day', d.d, 'runs', d.runs, 'rain', d.rain, 'rec', JSON.stringify(d.rec), 't3', JSON.stringify(d.t[3]), 't2', JSON.stringify(d.t[2]));
  console.log('miss7', a.miss7); console.log('missTop', JSON.stringify(a.missTop, null, 1));
  process.exit(0);
}
// กล้อง: นับกล้องใน กทม. ของแต่ละแหล่ง
{
  const cams = await fetch('https://camera.longdo.com/feed/?command=json').then((r) => r.json()).catch((e) => (console.log('longdo ERR', e.message), []));
  const bkk = cams.filter((c) => +c.latitude >= 13.48 && +c.latitude <= 13.97 && +c.longitude >= 100.32 && +c.longitude <= 100.95);
  const by = {};
  for (const c of bkk) { const k = (c.organization || '?') + ' | ' + (/^https:/.test(c.hls_url || '') && !/tempsus/.test(c.hls_url) ? 'hls' : 'no-hls') + ' | ' + (c.imgurl ? 'img' : 'no-img'); by[k] = (by[k] || 0) + 1; }
  console.log('\n### Longdo cameras total', cams.length, 'in BKK', bkk.length); console.log(by);
  const img = bkk.find((c) => c.imgurl && !(/^https:/.test(c.hls_url || '')));
  if (img) { console.log('sample no-hls cam', JSON.stringify(img).slice(0, 500)); const r = await fetch(img.imgurl).catch(() => null); console.log('img fetch', r && r.status, r && r.headers.get('content-type'), r && r.headers.get('access-control-allow-origin')); }
}
for (const ep of ['cctv', 'cctv_load', 'camera', 'bma_cctv', 'flood_cctv', 'rain_1h', 'rain_3d', 'rain_today', 'waterlevel_graph', 'pump', 'floodgate', 'flood_gate', 'watergate', 'sea_level', 'tide', 'storm_load', 'warning', 'drain']) await probe('TW ' + ep, TW + ep, TWH);
await probe('BMA traffic cams', 'http://www.bmatraffic.com/index.aspx');
await probe('iTIC cams', 'https://www.iticfoundation.org/api/camera');
process.exit(0);
const fr = await probe('ThaiWater flood_road', TW + 'flood_road', TWH);
await probe('ThaiWater canal_waterlevel', TW + 'canal_waterlevel', TWH);
const rows = fr && (Array.isArray(fr.data) ? fr.data : fr.data && fr.data.data) || [];
const st = rows.find((r) => /FL\./.test(JSON.stringify(r))) || rows[0];
const id = st && (st.station_id ?? (st.station && st.station.id) ?? st.id);
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
if (id != null) {
  await probe(`ThaiWater flood_road_graph id=${id} 7 days`, `${TW}flood_road_graph?station_id=${id}&date_start=${day(7)}&date_end=${day(0)}`, TWH);
  await probe(`ThaiWater flood_road_graph id=${id} 400 days`, `${TW}flood_road_graph?station_id=${id}&date_start=${day(400)}&date_end=${day(0)}`, TWH);
}
await probe('HII tide table', 'https://fews2.hii.or.th/model-output/data_portal/tide_table/summary.txt');
await probe('HII storm surge', 'https://api.hii.or.th/tiservice/v1/ws/cEniGCuZcTBSa3xj4A8PY187BhpExTfE/model/stromsurge/station_info');
await probe('BMA open data package', 'https://data.bangkok.go.th/api/3/action/package_show?id=risk-flood-bangkok-area');
await probe('BMA risk CSV 2566', 'https://data.bangkok.go.th/dataset/a1cc1d7a-6d87-4dd2-a662-79ed58c2623c/resource/b719945f-f10b-4b4c-afd2-2e8b43d21726/download/-2566.csv');
await probe('BMA open data search flood', 'https://data.bangkok.go.th/api/3/action/package_search?q=%E0%B8%99%E0%B9%89%E0%B8%B3%E0%B8%97%E0%B9%88%E0%B8%A7%E0%B8%A1&rows=20');
await probe('RainViewer maps', 'https://api.rainviewer.com/public/weather-maps.json');
