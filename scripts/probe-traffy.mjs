// สำรวจว่า Traffy public API รองรับการดึงย้อนหลัง (offset / ช่วงวันที่ / ประเภท) แค่ไหน
const API = 'https://publicapi.traffy.in.th/share/teamchadchart/search';
const d7 = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), d30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
const tests = [
  'limit=5', 'limit=5&offset=500', 'limit=5&offset=5000',
  `limit=5&start=${d30}&end=${d7}`, `limit=5&start_date=${d30}&end_date=${d7}`,
  'limit=5&type=น้ำท่วม', 'limit=5&problem_type=น้ำท่วม', 'limit=5&keyword=น้ำท่วม',
  'limit=5&sort=asc', 'limit=1000',
];
for (const q of tests) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 90000);
    const r = await fetch(API + '?' + q.replace(/น้ำท่วม/, encodeURIComponent('น้ำท่วม')), { signal: ctl.signal }); clearTimeout(tm);
    const j = await r.json().catch(() => null);
    const res = (j && j.results) || [];
    const ts = res.map((x) => x.timestamp).filter(Boolean).sort();
    const types = [...new Set(res.flatMap((x) => [].concat(x.type || [], x.problem_type_abdul || [])))].slice(0, 6);
    console.log(`${q} → HTTP ${r.status} ${res.length} เรื่อง total=${j && (j.total ?? j.count ?? '-')} ${ts[0] || ''} … ${ts[ts.length - 1] || ''} types=${JSON.stringify(types)} keys=${j ? Object.keys(j).join(',') : '-'} ${Date.now() - t0}ms`);
  } catch (e) { console.log(`${q} → ERROR ${e.message} ${Date.now() - t0}ms`); }
}
