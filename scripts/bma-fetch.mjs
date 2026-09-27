#!/usr/bin/env node
// ดึงข้อมูลเซ็นเซอร์น้ำท่วมถนน กทม. จากเครื่องที่อยู่ในประเทศไทย แล้วส่งขึ้น GitHub (branch bma-data)
//
// ทำไม: floodbangkok.bangkok.go.th ปฏิเสธเครื่องนอกประเทศ (รวม GitHub Actions) จึงต้องมีเครื่องในไทยช่วยดึง
// เครื่องที่ใช้ได้: NAS (Docker/Task Scheduler), Raspberry Pi, มือถือ Android (Termux), คอมที่เปิดทิ้งไว้
// ต้องมี Node.js 18 ขึ้นไป ไม่ต้องติดตั้งแพ็กเกจเพิ่ม
//
// ตั้งค่าผ่าน environment:
//   GH_TOKEN   fine-grained token เฉพาะ repo นี้ สิทธิ์ Contents: Read and write (ห้ามใส่ไว้ในไฟล์ที่ commit)
//   GH_REPO    (ไม่บังคับ) ค่าเริ่มต้น apichaetth/bkk-flood-map
//
// ใช้งาน:
//   GH_TOKEN=xxx node bma-fetch.mjs            ดึงและส่ง 1 ครั้ง (ใช้กับ cron ทุก 15 นาที)
//   GH_TOKEN=xxx node bma-fetch.mjs --loop 15  วนทำทุก 15 นาทีไม่หยุด (สำหรับ Termux / Docker)
//   node bma-fetch.mjs --dry                   ดึงอย่างเดียว พิมพ์สรุป ไม่ส่ง (ทดสอบว่าเครื่องนี้ดึงได้)

const REPO = process.env.GH_REPO || 'apichaetth/bkk-flood-map';
const BRANCH = 'bma-data';
const FILE = 'bma-sensors.json';
const API = process.env.BMA_API || 'https://floodbangkok.bangkok.go.th/bkk/dds/services/api/floods/v1/items/';
const GH_API = process.env.GH_API || 'https://api.github.com'; // เปลี่ยนได้เพื่อทดสอบ
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LOOP = args.includes('--loop') ? Math.max(5, +args[args.indexOf('--loop') + 1] || 15) : 0;
const log = (...a) => console.log(new Date().toLocaleString('th-TH'), ...a);

async function get(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url.split('?')[0]}`), { status: res.status, text });
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}
// เวลาที่ไม่มีเขตเวลา ถือเป็นเวลาไทย (เหมือนหน้าเว็บ)
const toMs = (s) => { if (!s) return null; const x = String(s).replace(' ', 'T'); return Date.parse(/Z$|[+-]\d\d(:?\d\d)?$/.test(x) ? x.replace(/\+00$/, 'Z') : x + '+07:00') || null; };
const num = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);

// เซิร์ฟเวอร์ กทม. ตอบ 503 "Under pressure" บ่อยช่วงมีคนใช้มาก: รอแล้วลองใหม่อีก 2 ครั้ง
async function bmaGet(url, opts = {}) {
  for (let i = 0; ; i++) {
    try { return await get(url, opts, 45000); }
    catch (e) {
      const busy = !e.status || e.status >= 500;
      if (!busy || i >= 2) throw e;
      log(`เซิร์ฟเวอร์ กทม. ไม่ว่าง (${e.status || e.message}) รอ ${20 * (i + 1)} วินาทีแล้วลองใหม่…`);
      await new Promise((r) => setTimeout(r, 20000 * (i + 1)));
    }
  }
}
let profiles = null, profilesAt = 0;
// 1) เซ็นเซอร์น้ำท่วมถนน (ระบบใหม่ floodbangkok): ตำแหน่ง + การแจ้งเตือนล่าสุดใน 3 ชม.
async function collectSensors() {
  // ตำแหน่งเซ็นเซอร์แทบไม่เปลี่ยน ดึงใหม่วันละครั้ง
  if (!profiles || Date.now() - profilesAt > 864e5) {
    profiles = (await bmaGet(API + 'sensor_profile?limit=-1&fields=id,code,name,road,district,lat,long')).data || [];
    profilesAt = Date.now();
  }
  const q = 'flood_notification?limit=1000&sort=-date_created&fields=sensor_profile,value,date_created';
  const nt = await bmaGet(API + q + '&filter[date_created][_gte]=' + encodeURIComponent('$NOW(-3 hours)'))
    .catch((e) => (e.status >= 400 && e.status < 500 ? bmaGet(API + q) : Promise.reject(e)));
  const latest = new Map();
  for (const n of (nt && nt.data) || []) if (!latest.has(n.sensor_profile)) latest.set(n.sensor_profile, n);
  return profiles
    .filter((s) => String(s.code || '').startsWith('FL.') && num(s.lat) && num(s.long))
    .map((s) => {
      const n = latest.get(s.id);
      return { id: s.id, code: s.code, name: s.name || '', road: s.road || '', district: s.district || '',
        la: +(+s.lat).toFixed(6), lo: +(+s.long).toFixed(6), cm: n ? num(n.value) : null, t: n ? toMs(n.date_created) : null };
    });
}

// 2–4) ระบบ DDS ของสำนักการระบายน้ำ (weather.bangkok.go.th): ฝน, ระดับน้ำคลอง, เซ็นเซอร์ถนน/อุโมงค์
const DDS = process.env.DDS_BASE || 'https://weather.bangkok.go.th/';
const ddsOpts = (ref, method = 'GET', body) => ({
  method, body,
  headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Referer: DDS + ref,
    ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
});
const netDate = (s) => { const m = /Date\((-?\d+)/.exec(s || ''); return m ? +m[1] : null; }; // "/Date(1790459700000)/"
const r6 = (v) => +(+v).toFixed(6);
async function collectRain() {
  const rows = await bmaGet(DDS + 'rain/PageMap/GetDataForUpdate', ddsOpts('rain', 'POST', ''));
  return (rows || []).filter((r) => num(r.latitude) && num(r.longitude)).map((r) => ({
    c: r.rain_code, n: r.rain_shortname || r.rain_name || '', d: r.district_name || '', la: r6(r.latitude), lo: r6(r.longitude), t: netDate(r.site_timestamp),
    r15: num(r.rf15min), r1: num(r.rf1hr), r3: num(r.rf3hr), r24: num(r.rf24hr), ok: r.status === 1,
  }));
}
// สถานะคลองตามเกณฑ์ของ กทม. เอง (ค่าเตือนภัย/วิกฤตบางสถานีคนละหน่วย จึงไม่คำนวณเอง)
const CANAL_ST = { 'ปกติ': 0, 'เตือนภัย': 1, 'วิกฤต': 2 };
async function collectCanal() {
  const rows = await bmaGet(DDS + 'water/PageMap/GoogleMap', ddsOpts('water', 'POST', 'payload=TEST_DATA_GOES_HERE'));
  return (rows || []).filter((r) => num(r.latitude) && num(r.longitude)).map((r) => ({
    c: r.water_code, n: r.water_shortname || r.water_name || '', river: r.river_name || '', d: r.district_name || '', la: r6(r.latitude), lo: r6(r.longitude),
    t: netDate(r.site_timestamp), wl: num(r.wl_in), warn: num(r.warning), crit: num(r.critical), st: CANAL_ST[r.txtStatus] ?? -1,
  }));
}
async function collectRoad() {
  const d = await bmaGet(DDS + 'Flood/PageMap/GetData?id=0', ddsOpts('flood/'));
  return ((d && d.dtTbl) || []).filter((r) => num(r.latitude) && num(r.longitude)).map((r) => {
    // น้ำท่วม = กำลังท่วม, ปกติ = แห้ง, ขัดข้อง = เซ็นเซอร์ไม่ส่งข้อมูล (ค่าความลึกเป็นค่าเก่า ไม่ใช้)
    const st = r.chkStatustxt === 'น้ำท่วม' ? 'flood' : r.chkStatustxt === 'ปกติ' ? 'ok' : 'off';
    return { c: r.flood_code, n: r.flood_shortname || r.flood_name || '', road: r.road_name || '', d: r.districtName || '', la: r6(r.latitude), lo: r6(r.longitude),
      t: netDate(r.site_timestamp), st, cm: st === 'flood' ? num(r.flood) : st === 'ok' ? 0 : null, max: num(r.flood_max),
      start: netDate(r.flood_start), tunnel: r.typesite === 2, dir: r.tunnel_sub_name || '' };
  });
}

async function collect() {
  const names = ['sensors', 'rain', 'canal', 'road'];
  const res = await Promise.allSettled([collectSensors(), collectRain(), collectCanal(), collectRoad()]);
  const out = { updated: new Date().toISOString(), source: 'floodbangkok.bangkok.go.th + weather.bangkok.go.th', errors: {} };
  res.forEach((r, i) => { if (r.status === 'fulfilled') out[names[i]] = r.value; else { out[names[i]] = []; out.errors[names[i]] = r.reason.message; } });
  if (Object.keys(out.errors).length === names.length) throw res[0].reason;
  return out;
}
const summary = (d) => {
  const e = Object.keys(d.errors).length ? ` · ดึงไม่ได้: ${Object.keys(d.errors).join(', ')}` : '';
  return `เซ็นเซอร์ ${d.sensors.length} จุด (น้ำ ≥5 ซม. ${d.sensors.filter((s) => s.cm >= 5).length}) · ฝน ${d.rain.length} สถานี`
    + ` · คลอง ${d.canal.length} (วิกฤต ${d.canal.filter((c) => c.st === 2).length}) · ถนน/อุโมงค์ ${d.road.length} (ท่วม ${d.road.filter((r) => r.st === 'flood').length})${e}`;
};

async function gh(pathname, opts = {}) {
  return get(GH_API + '/repos/' + REPO + pathname, {
    ...opts,
    headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bkk-flood-bma-fetch', ...(opts.headers || {}) },
  });
}
async function push(obj) {
  // สร้าง branch bma-data จาก main ครั้งแรก
  try { await gh('/git/ref/heads/' + BRANCH); }
  catch (e) {
    if (e.status !== 404) throw e;
    const main = await gh('/git/ref/heads/main');
    await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha: main.object.sha }) });
    log('สร้าง branch', BRANCH);
  }
  let sha;
  try { sha = (await gh(`/contents/${FILE}?ref=${BRANCH}`)).sha; } catch (e) { if (e.status !== 404) throw e; }
  const content = Buffer.from(JSON.stringify(obj)).toString('base64');
  await gh('/contents/' + FILE, { method: 'PUT', body: JSON.stringify({ message: 'bma sensors ' + obj.updated, content, sha, branch: BRANCH }) });
}

async function once() {
  try {
    const d = await collect();
    if (DRY) { log('ดึงได้: ' + summary(d) + ' (โหมดทดสอบ ไม่ส่ง)'); return true; }
    if (!process.env.GH_TOKEN) throw new Error('ไม่ได้ตั้ง GH_TOKEN');
    await push(d);
    log('ส่งแล้ว: ' + summary(d));
    return true;
  } catch (e) {
    const hint = e.status === 403 && /bangkok/.test(e.message) ? '(เครื่องนี้อาจไม่ได้อยู่ในไทย หรือใช้ VPN อยู่)'
      : e.status === 503 ? '(เซิร์ฟเวอร์ กทม. ไม่ว่าง ไม่ใช่ปัญหาที่เครื่องนี้)' : '';
    log('ไม่สำเร็จ:', e.message, hint);
    return false;
  }
}

if (LOOP) {
  log(`เริ่มวนทุก ${LOOP} นาที (กด Ctrl+C เพื่อหยุด)`);
  // รอบที่ไม่สำเร็จ ลองใหม่ใน 3 นาที ไม่ต้องรอครบรอบ
  for (;;) { const ok = await once(); await new Promise((r) => setTimeout(r, (ok ? LOOP : 3) * 6e4)); }
} else {
  process.exitCode = (await once()) ? 0 : 1;
}
