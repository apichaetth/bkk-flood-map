// สำรวจ API สาธารณะของ ThaiWater (รันด้วยมือจาก workflow probe-thaiwater) พิมพ์โครงสร้างข้อมูลแต่ละ endpoint
const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/';
const EP = process.argv.slice(2).length ? process.argv.slice(2) : [
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
for (const ep of EP) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
    const r = await fetch(TW + ep, { headers: { Referer: 'https://www.thaiwater.net/' }, signal: ctl.signal });
    const txt = await r.text(); clearTimeout(t);
    let out = txt.slice(0, 200);
    try { out = shape(JSON.parse(txt)).slice(0, 2500); } catch { /* ไม่ใช่ JSON */ }
    console.log(`\n### ${ep} HTTP ${r.status} ${(txt.length / 1024).toFixed(0)}KB\n${out}`);
  } catch (e) { console.log(`\n### ${ep} ERROR ${e.message}`); }
}
