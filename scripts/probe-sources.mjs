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
// เทียบค่า ThaiWater flood_road กับไฟล์จากเครื่องในไทย (หน่วยเดียวกันไหม)
const r1 = await fetch(TW + 'flood_road', { headers: TWH }).then((r) => r.json());
const rel = await fetch('https://raw.githubusercontent.com/apichaetth/bkk-flood-map/bma-data/bma-sensors.json?t=' + Date.now()).then((r) => r.json()).catch(() => null);
const byCode = new Map(((rel && rel.sensors) || []).map((x) => [x.code, x]));
const nz = (r1.data || []).filter((x) => +x.floodroad_value > 0).sort((a, b) => b.floodroad_value - a.floodroad_value);
console.log('ThaiWater nonzero', nz.length, 'relay updated', rel && rel.updated);
for (const x of nz.slice(0, 40)) { const c = x.station.floodroad_oldcode, r = byCode.get(c); console.log(c, 'TW', x.floodroad_value, x.floodroad_datetime, '| relay', r ? `${r.cm} @ ${r.t ? new Date(r.t + 7 * 36e5).toISOString().slice(11, 16) : '-'}` : '-'); }
const both = [...byCode.values()].filter((r) => r.cm != null).slice(0, 30);
console.log('relay sensors with values, ThaiWater same code:');
for (const r of both) { const x = (r1.data || []).find((y) => y.station.floodroad_oldcode === r.code); console.log(r.code, 'relay', r.cm, '| TW', x && x.floodroad_value, x && x.floodroad_datetime); }
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
