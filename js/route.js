/* หน้าหาเส้นทางเลี่ยงน้ำท่วม: จุดที่ควรหลบจาก data/avoid.json (GitHub Actions ทำทุก 15 นาที)
   หาเส้นทางรถยนต์ผ่าน Apps Script → openrouteservice (avoid_polygons) แล้วส่งต่อให้ Google Maps นำทาง */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtTime } = F;
  const KIND = { 0: ['น้ำท่วม', '#c0392b', 80], 1: ['ควรระวังมาก', '#f39c12', 50], 2: ['ควรระวัง', '#f5c542', 40] }; // ชื่อ, สี, รัศมีหลบ (ม.)
  const MAX_POLY = 400;

  const map = L.map('rmap', { preferCanvas: true, zoomControl: true }).setView([13.75, 100.56], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const ptLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map);

  // ---------- จุดที่ควรหลบ ----------
  let avoid = [];
  async function loadAvoid() {
    try {
      const d = await F.getJSON('data/avoid.json', 30000, { cache: 'no-cache' });
      avoid = (d.p || []).map(([la, lo, k, label]) => ({ la, lo, k, label: label || '' }));
      const n0 = avoid.filter((p) => p.k === 0).length, n1 = avoid.filter((p) => p.k === 1).length;
      $('updated').textContent = `ข้อมูลจุดน้ำท่วม ${fmtTime(new Date(d.updated))} · น้ำท่วม ${n0} จุด · ถนนควรระวังมาก ${n1} ช่วง · อัปเดตทุก 15 นาที`;
    } catch (e) { $('updated').textContent = 'โหลดข้อมูลจุดน้ำท่วมไม่ได้ (' + e.message + ') ยังหาเส้นทางปกติได้'; }
    drawPoints();
  }
  const strict = () => document.querySelector('input[name="mode"]:checked').value === 'strict';
  function drawPoints() {
    ptLayer.clearLayers();
    for (const p of avoid) {
      if (p.k === 2 && !strict()) continue;
      const [name, color] = KIND[p.k];
      L.circleMarker([p.la, p.lo], { radius: p.k === 0 ? 6 : 3.5, color: '#fff', weight: p.k === 0 ? 1.5 : 0.5, fillColor: color, fillOpacity: p.k === 0 ? 1 : 0.8 })
        .bindTooltip(esc(p.label ? `${name}: ${p.label}` : name)).addTo(ptLayer);
    }
  }
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.onchange = drawPoints);

  // ---------- ต้นทาง / ปลายทาง ----------
  const P = { A: null, B: null }, M = {};
  const pin = (k) => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<span class="rt-dot ${k.toLowerCase()}" style="width:26px;height:26px;box-shadow:0 1px 4px #0006">${k}</span>` });
  function setPoint(k, la, lo, label) {
    P[k] = { la, lo, label };
    $('q' + k).value = label;
    if (M[k]) M[k].setLatLng([la, lo]);
    else M[k] = L.marker([la, lo], { icon: pin(k), draggable: true, zIndexOffset: 1000 }).addTo(map)
      .on('dragend', (e) => { const ll = e.target.getLatLng(); setPoint(k, ll.lat, ll.lng, 'จุดที่เลือกบนแผนที่'); });
    $('go').disabled = !(P.A && P.B);
    if (P.A && P.B) map.fitBounds(L.latLngBounds([[P.A.la, P.A.lo], [P.B.la, P.B.lo]]).pad(0.25));
    else map.setView([la, lo], Math.max(map.getZoom(), 13));
  }
  map.on('click', (e) => setPoint(P.A ? 'B' : 'A', e.latlng.lat, e.latlng.lng, 'จุดที่เลือกบนแผนที่'));
  $('meA').onclick = () => {
    if (!navigator.geolocation) { status('เบราว์เซอร์นี้ไม่รองรับการหาตำแหน่ง'); return; }
    status('กำลังหาตำแหน่งของคุณ…');
    navigator.geolocation.getCurrentPosition((p) => { setPoint('A', p.coords.latitude, p.coords.longitude, 'ตำแหน่งของฉัน'); status(''); },
      () => status('หาตำแหน่งไม่ได้ (ต้องอนุญาตให้เว็บเข้าถึงตำแหน่ง)'), { enableHighAccuracy: true, timeout: 15000 });
  };
  $('swap').onclick = () => {
    const a = P.A, b = P.B;
    if (b) setPoint('A', b.la, b.lo, b.label); else { P.A = null; $('qA').value = ''; }
    if (a) setPoint('B', a.la, a.lo, a.label); else { P.B = null; $('qB').value = ''; }
  };
  // ค้นหาสถานที่ (Nominatim · จำกัดในกรุงเทพฯ และปริมณฑล)
  for (const k of ['A', 'B']) {
    let timer = null;
    const box = $('sug' + k);
    $('q' + k).addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (q.length < 3) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=th&countrycodes=th&bounded=1&viewbox=100.2,14.1,101.0,13.4&q=' + encodeURIComponent(q);
          const r = await F.getJSON(u, 15000);
          box.innerHTML = r.length ? r.map((x, i) => `<button type="button" data-i="${i}">${esc(x.display_name)}</button>`).join('') : '<p class="muted small" style="padding:8px">ไม่พบสถานที่ ลองพิมพ์ชื่ออื่น หรือแตะบนแผนที่</p>';
          box.hidden = false;
          box.querySelectorAll('button').forEach((b) => b.onclick = () => {
            const x = r[+b.dataset.i];
            setPoint(k, +x.lat, +x.lon, x.name || x.display_name.split(',')[0]);
            box.hidden = true;
          });
        } catch (err) { box.innerHTML = '<p class="muted small" style="padding:8px">ค้นหาไม่ได้ขณะนี้ แตะบนแผนที่แทนได้</p>'; box.hidden = false; }
      }, 450);
    });
  }

  // ---------- หาเส้นทาง ----------
  const status = (t) => { $('rtStatus').textContent = t; };
  const mPerDeg = 111320;
  const dM = (a, b, c, d) => Math.hypot((c - a) * mPerDeg, (d - b) * mPerDeg * Math.cos(a * Math.PI / 180));
  // ระยะจากจุดถึงเส้นทาง (ม.)
  function distToLine(la, lo, coords) {
    const kx = Math.cos(la * Math.PI / 180) * mPerDeg;
    let best = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const ax = (coords[i - 1][1] - lo) * kx, ay = (coords[i - 1][0] - la) * mPerDeg, bx = (coords[i][1] - lo) * kx, by = (coords[i][0] - la) * mPerDeg;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
    }
    return best;
  }
  function octagon(la, lo, r) {
    const ring = [];
    for (let i = 0; i <= 8; i++) { const a = (i % 8) * Math.PI / 4; ring.push([lo + (r * Math.cos(a)) / (mPerDeg * Math.cos(la * Math.PI / 180)), la + (r * Math.sin(a)) / mPerDeg]); }
    return [ring];
  }
  function pickAvoid() {
    const kinds = strict() ? [0, 1, 2] : [0, 1];
    const s = Math.min(P.A.la, P.B.la) - 0.03, n = Math.max(P.A.la, P.B.la) + 0.03, w = Math.min(P.A.lo, P.B.lo) - 0.03, e = Math.max(P.A.lo, P.B.lo) + 0.03;
    const line = [[P.A.la, P.A.lo], [P.B.la, P.B.lo]];
    return avoid
      .filter((p) => kinds.includes(p.k) && p.la >= s && p.la <= n && p.lo >= w && p.lo <= e)
      // จุดที่อยู่ติดต้นทาง/ปลายทางหลบไม่ได้ (ต้องออกจากตรงนั้นอยู่ดี)
      .filter((p) => dM(p.la, p.lo, P.A.la, P.A.lo) > 150 && dM(p.la, p.lo, P.B.la, P.B.lo) > 150)
      .map((p) => ({ p, d: distToLine(p.la, p.lo, line) }))
      .sort((a, b) => a.p.k - b.p.k || a.d - b.d)
      .slice(0, MAX_POLY).map(({ p }) => p);
  }
  const floodOn = (coords) => avoid.filter((p) => p.k === 0 && distToLine(p.la, p.lo, coords) <= 40);
  const km = (m) => (m / 1000).toFixed(1) + ' กม.', min = (s) => Math.round(s / 60) + ' นาที';
  function gmapsLink(coords) {
    // ส่งจุดผ่าน 8 จุดที่กระจายตามระยะทาง ให้ Google Maps วิ่งตามเส้นทางที่หลบน้ำ
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    const total = cum[cum.length - 1], wps = [];
    for (let j = 1; j <= 8; j++) { const t = (total * j) / 9; let i = cum.findIndex((c) => c >= t); if (i < 0) i = coords.length - 1; wps.push(coords[i]); }
    const f = (p) => p[0].toFixed(5) + ',' + p[1].toFixed(5);
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${f([P.A.la, P.A.lo])}&destination=${f([P.B.la, P.B.lo])}&waypoints=${encodeURIComponent(wps.map(f).join('|'))}`;
  }
  $('go').onclick = async () => {
    if (!P.A || !P.B) return;
    const ep = await F.reportEndpoint();
    if (!ep) { status('ระบบหาเส้นทางยังไม่เปิดใช้'); return; }
    const pts = pickAvoid();
    $('go').disabled = true; status(`กำลังหาเส้นทาง (หลบ ${pts.length} จุด)…`);
    routeLayer.clearLayers(); $('result').innerHTML = '';
    try {
      const res = await F.getJSON(ep, 60000, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'route', device: F.deviceId(), start: [P.A.lo, P.A.la], end: [P.B.lo, P.B.la], avoid: pts.map((p) => octagon(p.la, p.lo, KIND[p.k][2])) }) });
      if (!res.ok) throw new Error(res.code === 'no-key' ? 'ระบบหาเส้นทางยังไม่ได้ตั้งค่า (รอผู้ดูแลเว็บ)' : res.error || 'หาเส้นทางไม่ได้');
      showResult(res, pts.length);
      status('');
    } catch (e) { status('หาเส้นทางไม่สำเร็จ: ' + e.message); }
    finally { $('go').disabled = false; }
  };
  function showResult(res, nAvoid) {
    const { safe, normal } = res;
    if (normal && normal.coords) L.polyline(normal.coords, { color: '#7a8594', weight: 5, opacity: 0.8, dashArray: '8 8' }).addTo(routeLayer);
    if (safe && safe.coords) {
      L.polyline(safe.coords, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(routeLayer);
      L.polyline(safe.coords, { color: '#0f5ea8', weight: 6 }).addTo(routeLayer);
      map.fitBounds(L.latLngBounds(safe.coords).pad(0.1));
    }
    const fN = normal && normal.coords ? floodOn(normal.coords) : [], fS = safe && safe.coords ? floodOn(safe.coords) : [];
    let msg = '';
    if (!safe || safe.error) {
      msg = `<p class="rt-warn">หาเส้นทางที่หลบน้ำท่วมทั้งหมดไม่ได้ (${esc((safe && safe.error) || '')}) อาจเพราะน้ำท่วมปิดทุกทาง ลองเลือก "หลบจุดน้ำท่วมจริง" แทนหลบเข้ม หรือเปลี่ยนเวลาเดินทาง</p>`;
    } else {
      const extraD = normal && normal.distance ? safe.distance - normal.distance : 0, extraT = normal && normal.duration ? safe.duration - normal.duration : 0;
      msg = `<div class="rt-res">
        <div class="tile"><div class="muted small">เส้นทางเลี่ยงน้ำ (สีน้ำเงิน)</div><b class="big">${km(safe.distance)}</b> · ~${min(safe.duration)}
          <div class="small">${fS.length ? `⚠️ ยังผ่านจุดน้ำท่วม ${fS.length} จุด (หลบไม่ได้)` : '✅ ไม่ผ่านจุดน้ำท่วมที่ระบบรู้'}</div></div>
        ${normal && normal.coords ? `<div class="tile"><div class="muted small">เส้นทางปกติ (เส้นประ)</div><b class="big">${km(normal.distance)}</b> · ~${min(normal.duration)}
          <div class="small">${fN.length ? `ผ่านจุดน้ำท่วม ${fN.length} จุด` : 'ไม่ผ่านจุดน้ำท่วมที่ระบบรู้'}</div></div>` : ''}
      </div>
      <p class="small">${normal && normal.coords ? (fN.length ? `เส้นทางเลี่ยงน้ำอ้อมเพิ่ม ${km(Math.max(0, extraD))} (~${min(Math.max(0, extraT))}) เพื่อหลบน้ำท่วม ${Math.max(0, fN.length - fS.length)} จุด` : 'เส้นทางปกติไม่ผ่านจุดน้ำท่วมที่ระบบรู้อยู่แล้ว') : ''} · หลบทั้งหมด ${nAvoid} จุด/ช่วงถนนในบริเวณนี้</p>
      <a class="btn primary rt-gmaps" href="${gmapsLink(safe.coords)}" target="_blank" rel="noopener">เปิดใน Google Maps ▸</a>
      <p class="muted small">Google Maps อาจปรับเส้นทางระหว่างจุดผ่านเล็กน้อย ดูจุดน้ำท่วมบนแผนที่นี้ประกอบ และห้ามขับฝ่าน้ำที่ไม่รู้ความลึก</p>`;
    }
    $('result').innerHTML = msg;
  }

  loadAvoid();
  setInterval(loadAvoid, F.REFRESH_MS);
})();
