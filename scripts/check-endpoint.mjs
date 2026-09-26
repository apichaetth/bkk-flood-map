// ตรวจ Apps Script Web App ก่อนเปลี่ยน endpoint ของเว็บ: อ่านรายงาน, อ่าน log, ส่งข้อความทดสอบ (feedback)
import { readFile } from 'node:fs/promises';
const ep = (await readFile('apps-script/candidate-endpoint.txt', 'utf8')).trim();
const show = async (label, p) => { try { const r = await p; const t = await r.text(); console.log(`\n### ${label} HTTP ${r.status}\n${t.slice(0, 600)}`); } catch (e) { console.log(`\n### ${label} ERROR ${e.message}`); } };
console.log('endpoint', ep);
await show('list', fetch(ep + '?action=list'));
await show('log', fetch(ep + '?action=log&limit=3'));
await show('feedback', fetch(ep, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({
  action: 'feedback', name: 'ระบบตรวจสอบอัตโนมัติ', contact: '', topic: 'ติดต่อเรื่องอื่น', device: 'ci-check',
  message: 'ทดสอบกล่องข้อความจากหน้าเกี่ยวกับ หลังอัปเดต Apps Script (ส่งจาก GitHub Actions ไม่ต้องตอบกลับ)', page: 'github-actions' }) }));
