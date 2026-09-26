// สำรวจเว็บสำนักการระบายน้ำ กทม. (dds.bangkok.go.th) ว่าแต่ละเมนูดึงข้อมูลจากที่ไหน (ไฟล์ JSON/API/iframe/รูป)
const UA = 'Mozilla/5.0 (compatible; bkk-flood-map probe)';
async function get(u) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' }); const txt = await r.text(); return { status: r.status, type: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin'), txt, url: r.url }; }
  catch (e) { return { status: 'ERR ' + e.message, txt: '' }; } finally { clearTimeout(t); }
}
const start = 'https://dds.bangkok.go.th/index2.php';
const home = await get(start);
console.log('HOME', home.status, home.type, home.txt.length);
const links = [...new Set([...home.txt.matchAll(/(?:href|src)\s*=\s*["']([^"'#]+)["']/gi)].map((m) => new URL(m[1], start).href))]
  .filter((u) => !/\.(css|png|jpe?g|gif|svg|ico|woff2?|ttf)(\?|$)/i.test(u) && !/facebook|twitter|youtube|google|line\.me/i.test(u));
console.log('\nLINKS', links.length); for (const l of links) console.log(' ', l);
// เปิดทีละลิงก์ในโดเมน กทม. แล้วหา endpoint ข้อมูลในหน้า
const seen = new Set();
for (const u of links.filter((l) => /bangkok\.go\.th|bma/i.test(l)).slice(0, 25)) {
  const r = await get(u);
  const eps = [...new Set([...r.txt.matchAll(/["'`](https?:\/\/[^"'`\s]+?(?:api|json|service|data|feed|getdata|\.php\?)[^"'`\s]*)["'`]/gi)].map((m) => m[1]))].slice(0, 12);
  const ifr = [...r.txt.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 5);
  console.log(`\n### ${u}\n  HTTP ${r.status} ${r.type || ''} ${r.txt.length}B cors=${r.cors}`);
  for (const e of [...ifr.map((x) => 'iframe ' + x), ...eps]) { if (!seen.has(e)) { seen.add(e); console.log('  ->', e); } }
}
