// สำรวจ API สาธารณะของ ThaiWater (รันด้วยมือจาก workflow probe-thaiwater) พิมพ์โครงสร้างข้อมูลแต่ละ endpoint
const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/';
const EP = process.argv.slice(2).length ? process.argv.slice(2) : ['detail'];
const OLD = [
  'public/thailand_main', 'public/rain_24h', 'public/rain_today', 'public/rain_yesterday', 'public/rain_3d', 'public/rain_7d', 'public/rain_1h',
  'public/waterlevel_load', 'public/waterlevel', 'public/dam_load', 'public/dam', 'public/dam_daily', 'public/waterquality_load', 'public/waterquality',
  'public/storm', 'public/storm_load', 'public/warning', 'public/warning_load', 'public/pre_rain', 'public/rain_forecast', 'public/tide', 'public/sea_level',
  'public/waterlevel_sea', 'public/floodgate', 'public/flood_gate', 'public/pump', 'public/radar', 'public/weather_img', 'public/flood_forecast',
  'public/latest_rain', 'public/province', 'public/metadata', 'public/wave', 'public/swan', 'public/drought', 'public/flow',
];
const shape = (v, d = 0) => {
  if (Array.isArray(v)) return `[${v.length}] ` + (v.length ? shape(v[0], d + 1) : '');
  if (v && typeof v === 'object') {
    if (d > 2) return '{' + Object.keys(v).slice(0, 25).join(',') + '}';
    return '{' + Object.entries(v).slice(0, 25).map(([k, x]) => k + ':' + shape(x, d + 1)).join(', ') + '}';
  }
  return JSON.stringify(v)?.slice(0, 40);
};
// โหมดดูตัวอย่างละเอียด: node probe-thaiwater.mjs detail
if (EP[0] === 'detail') {
  const r = await fetch(TW + 'public/thailand_main', { headers: { Referer: 'https://www.thaiwater.net/' } });
  const j = await r.json();
  const pick = (o, ...k) => k.reduce((a, x) => (a == null ? a : a[x]), o);
  const show = (label, v) => console.log(`\n### ${label}\n` + JSON.stringify(v, null, 1).slice(0, 3000));
  show('pre_rain', pick(j, 'pre_rain', 'data', 'data'));
  show('pre_rain_basin', pick(j, 'pre_rain_basin', 'data', 'data'));
  show('pre_rain_animation', pick(j, 'pre_rain_animation', 'data'));
  show('radar[0..2]', (pick(j, 'radar', 'data', 'data') || []).slice(0, 2));
  show('temp_data2', pick(j, 'warning', 'temp_data2', 'data'));
  const dams = pick(j, 'dam', 'data', 'data') || [];
  show('dam[0]', dams[0]);
  console.log('\n### dam names', dams.map((d) => (d.dam && d.dam.dam_name && d.dam.dam_name.th) + ' ' + d.dam_date + ' ' + d.dam_storage_percent + '% rel ' + d.dam_released).join('\n'));
  // ลองหา URL รูป
  const m = pick(j, 'pre_rain', 'data', 'data', 0);
  if (m) for (const u of [
    'https://api-v3.thaiwater.net/api/v1/thaiwater30/shared/image?image=' + m.media_path,
    'https://api-v3.thaiwater.net/api/v1/thaiwater30/shared/image?image=' + m.file_path + '/' + m.filename,
    'https://api-v3.thaiwater.net/' + m.media_path, 'https://www.thaiwater.net/' + m.media_path, 'https://live1.hii.or.th/' + m.media_path,
  ]) { try { const x = await fetch(u, { headers: { Referer: 'https://www.thaiwater.net/' } }); console.log('IMG', x.status, x.headers.get('content-type'), x.headers.get('access-control-allow-origin'), u); } catch (e) { console.log('IMG ERR', u, e.message); } }
  process.exit(0);
}
for (const ep of EP) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
    const r = await fetch(TW + ep, { headers: { Referer: 'https://www.thaiwater.net/' }, signal: ctl.signal });
    const txt = await r.text(); clearTimeout(t);
    let out = txt.slice(0, 200);
    try {
      const j = JSON.parse(txt);
      // ออบเจ็กต์ใหญ่ (เช่น thailand_main) พิมพ์ทีละคีย์ จะได้ไม่ถูกตัด
      out = j && !Array.isArray(j) && txt.length > 500000 ? Object.entries(j).map(([k, v]) => `  - ${k}: ${shape(v, 1).slice(0, 900)}`).join('\n') : shape(j).slice(0, 2500);
    } catch { /* ไม่ใช่ JSON */ }
    console.log(`\n### ${ep} HTTP ${r.status} ${(txt.length / 1024).toFixed(0)}KB\n${out}`);
  } catch (e) { console.log(`\n### ${ep} ERROR ${e.message}`); }
}
