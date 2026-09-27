// เฝ้าเว็บจริง: ถ้าข้อมูลไม่อัปเดตเกิน 60 นาที หรือแหล่งหลักล่มพร้อมกัน ให้ workflow ล้ม
// (GitHub จะส่งอีเมลแจ้งเจ้าของ repo เองเมื่อ workflow ตามเวลาล้ม)
const BASE = process.env.SITE || 'https://apichaetth.github.io/bkk-flood-map/';
const get = async (p) => {
  const r = await fetch(BASE + p + '?t=' + Date.now(), { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(p + ' HTTP ' + r.status);
  return r.json();
};
const problems = [];
let meta;
try { meta = await get('data/meta.json'); } catch (e) { problems.push('อ่าน meta.json ไม่ได้: ' + e.message); }
if (meta) {
  const age = (Date.now() - new Date(meta.updated)) / 60000;
  console.log('updated', meta.updated, `(${age.toFixed(0)} นาทีที่แล้ว)`);
  if (!(age <= 60)) problems.push(`ข้อมูลไม่อัปเดตมา ${isFinite(age) ? age.toFixed(0) : '?'} นาที (cron-job.org หรือ workflow update-data อาจหยุด)`);
  const s = meta.sources || {};
  for (const [k, v] of Object.entries(s)) console.log(k.padEnd(12), v && v.ok === false ? 'FAIL ' + (v.error || '') : 'ok');
  // เซ็นเซอร์ถนนต้องมาอย่างน้อยหนึ่งทาง (เครื่องส่งต่อ หรือ ThaiWater)
  const bad = (k) => !s[k] || s[k].ok === false;
  if (bad('bma') && bad('bmaTw')) problems.push('ไม่มีข้อมูลเซ็นเซอร์ถนนเลย (ทั้ง ThaiWater และเครื่องส่งต่อ)');
  // Traffy ล่มบ่อยเป็นพัก ๆ แค่เตือน (ข้อมูลเก่ายังสะสมอยู่)
  if (bad('traffy')) console.log('::warning::ดึง Traffy รอบล่าสุดไม่ได้: ' + ((s.traffy && s.traffy.error) || 'ไม่มีข้อมูล'));
}
try {
  // อ่านจาก branch ที่เครื่องส่งต่อ push ตรง ๆ (ไฟล์บนเว็บจะเป็น ThaiWater แทนเมื่อเครื่องไม่ส่ง)
  const r = await fetch(process.env.RELAY || 'https://raw.githubusercontent.com/apichaetth/bkk-flood-map/bma-data/bma-sensors.json');
  if (!r.ok) throw new Error('bma-data HTTP ' + r.status);
  const relay = await r.json();
  const age = (Date.now() - new Date(relay.updated)) / 60000;
  console.log('relay', relay.source || '', relay.updated, `(${age.toFixed(0)} นาที)`);
  // แค่เตือน ไม่ทำให้ล้ม: ThaiWater ยังเป็นสำรองอยู่
  if (age > 120) console.log('::warning::เครื่องส่งต่อข้อมูล กทม. ไม่ส่งมา ' + age.toFixed(0) + ' นาที');
} catch (e) { console.log('::warning::' + e.message); }
if (problems.length) {
  for (const p of problems) console.log('::error::' + p);
  process.exit(1);
}
console.log('ปกติ');
