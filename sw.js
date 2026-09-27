/* ใช้เป็นแอปได้ + เปิดได้ตอนเน็ตหลุด: ดึงจากเน็ตก่อนเสมอ (ข้อมูลน้ำท่วมต้องใหม่ที่สุด)
   ถ้าดึงไม่ได้ค่อยใช้ของที่เก็บไว้ครั้งล่าสุด · ของเว็บอื่นเก็บเฉพาะไลบรารีที่ระบุเวอร์ชันจาก jsDelivr (แผนที่) */
const CACHE = 'bkkflood-v1', LIB = 'bkkflood-lib-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== LIB).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === 'https://cdn.jsdelivr.net' && /@\d/.test(url.pathname)) {
    // ไฟล์ที่ล็อกเวอร์ชันไม่เปลี่ยน: ใช้ของในเครื่องก่อน
    e.respondWith(caches.open(LIB).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit
    || (req.mode === 'navigate' ? caches.match('./', { ignoreSearch: true }) : Response.error()))));
});
