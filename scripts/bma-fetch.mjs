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

let profiles = null, profilesAt = 0;
async function collect() {
  // ตำแหน่งเซ็นเซอร์แทบไม่เปลี่ยน ดึงใหม่วันละครั้ง
  if (!profiles || Date.now() - profilesAt > 864e5) {
    profiles = (await get(API + 'sensor_profile?limit=-1&fields=id,code,name,road,district,lat,long', {}, 45000)).data || [];
    profilesAt = Date.now();
  }
  const q = 'flood_notification?limit=1000&sort=-date_created&fields=sensor_profile,value,date_created';
  const nt = await get(API + q + '&filter[date_created][_gte]=' + encodeURIComponent('$NOW(-3 hours)'), {}, 45000)
    .catch((e) => (e.status >= 400 && e.status < 500 ? get(API + q, {}, 45000) : Promise.reject(e)));
  const latest = new Map();
  for (const n of (nt && nt.data) || []) if (!latest.has(n.sensor_profile)) latest.set(n.sensor_profile, n);
  const sensors = profiles
    .filter((s) => String(s.code || '').startsWith('FL.') && num(s.lat) && num(s.long))
    .map((s) => {
      const n = latest.get(s.id);
      return { id: s.id, code: s.code, name: s.name || '', road: s.road || '', district: s.district || '',
        la: +(+s.lat).toFixed(6), lo: +(+s.long).toFixed(6), cm: n ? num(n.value) : null, t: n ? toMs(n.date_created) : null };
    });
  return { updated: new Date().toISOString(), source: 'floodbangkok.bangkok.go.th', sensors };
}

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
    const withData = d.sensors.filter((s) => s.cm != null).length, wet = d.sensors.filter((s) => s.cm >= 5).length;
    if (DRY) { log(`ดึงได้ ${d.sensors.length} จุด มีค่าล่าสุด ${withData} จุด น้ำ ≥5 ซม. ${wet} จุด (โหมดทดสอบ ไม่ส่ง)`); return true; }
    if (!process.env.GH_TOKEN) throw new Error('ไม่ได้ตั้ง GH_TOKEN');
    await push(d);
    log(`ส่งแล้ว: ${d.sensors.length} จุด มีค่าล่าสุด ${withData} จุด น้ำ ≥5 ซม. ${wet} จุด`);
    return true;
  } catch (e) {
    log('ไม่สำเร็จ:', e.message, e.status === 403 && /bangkok/.test(e.message) ? '(เครื่องนี้อาจไม่ได้อยู่ในไทย หรือใช้ VPN อยู่)' : '');
    return false;
  }
}

if (LOOP) {
  log(`เริ่มวนทุก ${LOOP} นาที (กด Ctrl+C เพื่อหยุด)`);
  for (;;) { await once(); await new Promise((r) => setTimeout(r, LOOP * 6e4)); }
} else {
  process.exitCode = (await once()) ? 0 : 1;
}
