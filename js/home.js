/* หน้าแรกแบบง่าย: ตอบ "แถวฉันท่วมไหม" ก่อน แล้วสรุปทั้งเมือง แผนที่ และจุดล่าสุด
 * โหลดไฟล์เดียว data/home.json (ระบบสรุปไว้ทุก 15 นาที) — เล็กและเร็วกว่าการดึงทุกแหล่งเอง */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, distKm, fmtTime, fmtDT, ago, LEVEL } = F;
  const FRESH_MS = 3 * 36e5, NEAR_KM = 1, CLOSE_KM = 0.5, AREA_KM = 2;
  const SRC = { sensor: 'เซ็นเซอร์ กทม.', itic: 'หน่วยงาน/iTIC', web: 'ประชาชนปักหมุด', traffy: 'Traffy', news: 'ข่าว', youtube: 'YouTube' };
  const PL_ICON = { home: '🏠', work: '🏢', other: '📍' };
  let H = null, me = null, fitted = false;

  // จุด: [lat, lng, ระดับ, ชื่อ, เขต, ซม., เวลา, แหล่ง[], จำนวน, รายละเอียด]
  const pts = () => (H ? H.c.filter((c) => c[2] >= 2).map(([la, lo, tier, name, d, cm, t, src, n, det]) => ({ la, lo, tier, name, d, cm, t, src, n, det, fresh: t && Date.now() - t <= FRESH_MS })) : []);
  // รายงานรายจุด (ตำแหน่ง/เวลา/แหล่งของแต่ละเรื่องจริง ไม่ใช่กลุ่ม 500 ม.) ใช้ตอบ "รอบตัวฉัน" ให้ตรงกับที่เห็นในแต่ละแหล่ง
  const reps = () => (H && H.m ? H.m.map(([la, lo, src, t, cm, name, det, link, tier]) => ({ la, lo, src, t, cm, name, det, link, tier, fresh: t && Date.now() - t <= FRESH_MS })) : pts().map((p) => ({ ...p, src: p.src[0] })));
  const m = (km) => (km < 1 ? Math.round(km * 1000) + ' ม.' : km.toFixed(1) + ' กม.');
  const depth = (p) => (p.cm ? `${p.cm} ซม.` : p.tier === 3 ? 'ท่วม' : 'มีรายงาน');

  // ---------- 1) แถวคุณ ----------
  // สถานะรอบจุด: ใช้เฉพาะรายงานใหม่ (≤ 3 ชม.) ตัดสิน ส่วนรายงานเก่าบอกเป็นหมายเหตุ
  function statusAt(la, lo) {
    // 🔴 ≤ 500 ม. · 🟠 ≤ 1 กม. · 🟡 ≤ 2 กม. · 🟢 ไม่มีในรัศมี 2 กม. — นับจากรายงานแต่ละเรื่องที่แจ้งภายใน 3 ชม.
    const all = reps().map((p) => ({ ...p, km: distKm(la, lo, p.la, p.lo) })).filter((p) => p.km <= AREA_KM).sort((a, b) => a.km - b.km);
    const fresh = all.filter((p) => p.fresh), in1 = fresh.filter((p) => p.km <= NEAR_KM);
    const n = fresh[0];
    const old = all.filter((p) => !p.fresh).length;
    const oldNote = old ? ` · มีรายงานเก่ากว่า 3 ชม. อีก ${old} เรื่อง (อาจลดแล้ว)` : '';
    const who = (p) => `${SRC[p.src] || p.src} ${ago(new Date(p.t))}`;
    if (n && n.km <= CLOSE_KM) return { lv: 3, head: `มีน้ำท่วมใกล้มาก ห่าง ${m(n.km)}`, sub: `${n.name} · ${depth(n)} · ${who(n)}${in1.length > 1 ? ` · ในรัศมี 1 กม. ${in1.length} รายงาน` : ''} · ในรัศมี 2 กม. ${fresh.length} รายงาน`, list: fresh };
    if (n && n.km <= NEAR_KM) return { lv: 2, head: `มีน้ำท่วมในรัศมี 1 กม. (${in1.length} รายงาน)`, sub: `ใกล้สุด ${n.name} ห่าง ${m(n.km)} · ${depth(n)} · ${who(n)}`, list: fresh };
    if (n) return { lv: 1, head: `มีน้ำท่วมในรัศมี 2 กม. (${fresh.length} รายงาน)`, sub: `ใกล้สุด ${n.name} ห่าง ${m(n.km)} · ${depth(n)} · ${who(n)} · ในรัศมี 1 กม. ยังไม่มีรายงาน${oldNote}`, list: fresh };
    return { lv: 0, head: 'ไม่มีรายงานน้ำท่วมในรัศมี 2 กม.', sub: 'ช่วง 3 ชม. ล่าสุด' + oldNote, list: [] };
  }
  // แถวรายงานรายเรื่อง: บอกแหล่ง เวลาแจ้งจริง ระยะ และลิงก์ไปดูเรื่องนั้นที่ต้นทาง (เช่น Traffy)
  function repRow(p, from) {
    const km = from ? `ห่าง ${m(distKm(from[0], from[1], p.la, p.lo))} · ` : '';
    const open = p.link ? `<a class="h2src" href="${esc(p.link)}" target="_blank" rel="noopener">ดูเรื่องนี้ที่ ${esc(SRC[p.src] || p.src)} ↗</a>` : '';
    return `<div class="h2row${p.fresh ? '' : ' old'}"><span class="h2d" style="--c:${p.fresh ? LEVEL[p.tier >= 3 ? 3 : 2].color : '#9aa4b1'}">${p.cm ? p.cm + '<small>ซม.</small>' : '•'}</span>`
      + `<span class="h2t"><b>${esc(p.name || 'ไม่ระบุชื่อ')}</b><small>${km}${esc(SRC[p.src] || p.src)} · แจ้ง ${p.t ? ago(new Date(p.t)) : '–'}${p.det ? ' · ' + esc(p.det) : ''}</small>${open}</span></div>`;
  }
  const verdict = (s, title) => `<div class="h2v lv${s.lv}"><span class="dot" style="--c:${LEVEL[s.lv].color}"></span><div>${title ? `<b class="h2vt">${esc(title)}</b>` : ''}<b>${esc(s.head)}</b><small>${esc(s.sub)}</small></div></div>`;
  function renderMe() {
    const places = F.store.get('bkkflood.places') || [];
    $('meSave').textContent = places.length ? '⭐ จัดการที่ของฉัน' : '⭐ บันทึกบ้าน/ที่ทำงาน';
    $('meList').innerHTML = !H ? '' : places.map((p) => verdict(statusAt(p.la, p.lo), `${PL_ICON[p.kind] || '📍'} ${p.name}`)).join('');
    if (me && H) {
      const s = statusAt(me[0], me[1]);
      $('meOut').innerHTML = verdict(s, '📍 รอบตัวคุณตอนนี้') + (s.list.length ? `<div class="h2list">${s.list.slice(0, 6).map((p) => repRow(p, me)).join('')}</div>`
        + (s.list.length > 6 ? `<p class="muted small">และอีก ${s.list.length - 6} รายงาน · <a href="map.html?lat=${me[0].toFixed(5)}&lng=${me[1].toFixed(5)}&z=15">ดูบนแผนที่ละเอียด →</a></p>` : '') : '');
    }
  }
  $('meNear').onclick = () => {
    const b = $('meNear');
    if (!navigator.geolocation) { $('meOut').innerHTML = '<p class="muted">อุปกรณ์นี้หาตำแหน่งไม่ได้</p>'; return; }
    b.textContent = 'กำลังหาตำแหน่ง…'; b.disabled = true;
    navigator.geolocation.getCurrentPosition((p) => {
      me = [p.coords.latitude, p.coords.longitude]; b.textContent = '📍 ดูรอบตัวฉันอีกครั้ง'; b.disabled = false;
      renderMe(); if (map) { map.setView(me, 13); drawMe(); }
    }, () => { b.textContent = '📍 ดูรอบตัวฉัน'; b.disabled = false; $('meOut').innerHTML = '<p class="muted">หาตำแหน่งไม่ได้ (ต้องอนุญาตให้เว็บเข้าถึงตำแหน่ง)</p>'; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  };

  // ---------- 2) ทั้งเมือง + แผนที่ ----------
  let map = null, lyr = null, meLyr = null;
  function initMap() {
    if (map || !window.L) return;
    map = L.map('hmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 17, preferCanvas: true, renderer: L.canvas({ padding: 0.3, tolerance: matchMedia('(pointer: coarse)').matches ? 14 : 6 }) })
      .setView([13.75, 100.6], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    lyr = L.layerGroup().addTo(map); meLyr = L.layerGroup().addTo(map);
    F.addLocate(map);
  }
  function popup(p) {
    return `<div class="pp"><h3>${esc(p.name)}</h3>${p.d ? `<div class="m">เขต${esc(p.d)}</div>` : ''}<div><b>${esc(depth(p))}</b> · ${p.t ? `${fmtDT(new Date(p.t))} (${ago(new Date(p.t))})` : ''}${p.fresh ? '' : ' <span class="m">อาจลดแล้ว</span>'}</div>`
      + `<div class="m" style="margin-top:4px">${(p.det || []).map(([s, txt, t, link]) => `${esc(SRC[s] || s)}${t ? ` (${ago(new Date(t))})` : ''}: ${esc(txt)}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">ดู ↗</a>` : ''}`).join('<br>')}</div>`
      + `<div style="margin-top:6px"><a href="map.html?lat=${p.la}&lng=${p.lo}&z=16">ดูบนแผนที่ละเอียด →</a></div></div>`;
  }
  function drawMap() {
    initMap(); if (!map) return;
    lyr.clearLayers();
    const col = [0, 1, 2, 3].map((l) => F.cssVar(['--good', '--warning', '--serious', '--critical'][l]));
    // เก่าก่อน ใหม่ทับด้านบน
    for (const p of pts().sort((a, b) => (a.fresh - b.fresh) || a.tier - b.tier)) {
      L.circleMarker([p.la, p.lo], { radius: p.fresh ? (p.tier === 3 ? 7 : 5) : 4, keepSize: true, color: '#fff', weight: 1.5,
        fillColor: p.fresh ? col[p.tier] : '#9aa4b1', fillOpacity: p.fresh ? 0.95 : 0.6 }).bindPopup(() => popup(p)).addTo(lyr);
    }
    drawMe();
  }
  function drawMe() {
    if (!meLyr) return;
    meLyr.clearLayers();
    for (const p of F.store.get('bkkflood.places') || []) L.marker([p.la, p.lo], { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="plm" style="--c:var(--accent)">${PL_ICON[p.kind] || '📍'}</div>` }) }).bindPopup(esc(p.name)).addTo(meLyr);
    if (me) {
      L.circle(me, { radius: NEAR_KM * 1000, color: F.cssVar('--accent'), weight: 1.5, dashArray: '5 5', fill: false, interactive: false }).addTo(meLyr);
      L.circle(me, { radius: AREA_KM * 1000, color: F.cssVar('--accent'), weight: 1, opacity: 0.6, dashArray: '2 6', fill: false, interactive: false }).addTo(meLyr);
      // ป้ายบอกรัศมีที่ขอบบนของแต่ละวง
      for (const km of [NEAR_KM, AREA_KM]) L.marker([me[0] + km / 111.2, me[1]], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [44, 18], iconAnchor: [22, 9], html: `<span class="ringlb">${km} กม.</span>` }) }).addTo(meLyr);
      L.circleMarker(me, { radius: 7, keepSize: true, color: '#fff', weight: 2, fillColor: F.cssVar('--accent'), fillOpacity: 1 }).bindPopup('ตำแหน่งของคุณ').addTo(meLyr);
    }
  }
  function renderCity() {
    const all = pts(), fresh = all.filter((p) => p.fresh);
    const dists = (H.d || []).filter((d) => d[1] >= 2);
    $('asof').textContent = `ข้อมูล ณ ${fmtDT(new Date(H.updated))}`;
    $('cityLine').innerHTML = fresh.length
      ? `น้ำท่วม <em>${fresh.length}</em> จุด ใน 3 ชม. ล่าสุด · <em>${new Set(fresh.map((p) => p.d).filter(Boolean)).size}</em> เขต`
      : all.length ? 'ช่วง 3 ชม. ล่าสุดไม่มีรายงานน้ำท่วมใหม่' : 'ขณะนี้ไม่มีรายงานน้ำท่วมใน กทม.';
    // เขตที่มีรายงานใหม่มากที่สุด
    const cnt = new Map();
    for (const p of fresh) if (p.d) cnt.set(p.d, (cnt.get(p.d) || 0) + (p.tier === 3 ? 2 : 1));
    const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('cityDists').innerHTML = top.length ? '<span class="muted small">หนักสุด:</span> ' + top.map(([d]) => `<a class="rchip" href="districts.html">เขต${esc(d)}</a>`).join('') : (dists.length ? `<span class="muted small">มีรายงานใน ${dists.length} เขต (ส่วนใหญ่เก่ากว่า 3 ชม.)</span>` : '');
  }

  // ---------- 3) ล่าสุด ----------
  function row(p, from) {
    const km = from ? ` · ห่าง ${m(distKm(from[0], from[1], p.la, p.lo))}` : '';
    return `<a class="h2row${p.fresh ? '' : ' old'}" href="map.html?lat=${p.la}&lng=${p.lo}&z=16"><span class="h2d" style="--c:${p.fresh ? LEVEL[p.tier].color : '#9aa4b1'}">${p.cm ? p.cm + '<small>ซม.</small>' : p.tier === 3 ? '!' : '•'}</span>`
      + `<span class="h2t"><b>${esc(p.name)}</b><small>${p.d ? 'เขต' + esc(p.d) + ' · ' : ''}${p.t ? 'ล่าสุด ' + ago(new Date(p.t)) : ''}${km}${p.fresh ? '' : ' (อาจลดแล้ว)'} · ${esc(p.src.map((s) => SRC[s] || s).join(', '))}</small></span></a>`;
  }
  function renderLatest() {
    const q = $('q').value.trim().replace(/^(ถนน|ถ\.|เขต)\s*/, '');
    let list = pts();
    if (q) list = list.filter((p) => (p.name + ' ' + p.d).includes(q));
    list.sort((a, b) => (b.fresh - a.fresh) || b.tier - a.tier || (b.cm || 0) - (a.cm || 0) || (b.t || 0) - (a.t || 0));
    const fresh = list.filter((p) => p.fresh).length;
    $('latestN').textContent = q ? `พบ ${list.length} จุด` : `ใหม่ ${fresh} จุด`;
    $('latest').innerHTML = list.length ? list.slice(0, q ? 20 : 10).map((p) => row(p, me)).join('') : `<p class="muted">${q ? 'ไม่พบจุดที่ตรงกับคำค้น' : 'ยังไม่มีรายงานน้ำท่วม'}</p>`;
  }
  $('q').addEventListener('input', renderLatest);

  // ---------- โหลด ----------
  async function load() {
    try {
      const d = await F.getJSON('data/home.json', 20000, { cache: 'no-cache' });
      if (!d || !Array.isArray(d.c)) throw new Error('ไม่มีข้อมูลสรุป');
      H = d;
      const stale = Date.now() - new Date(d.updated) > 45 * 6e4;
      $('updated').textContent = `อัปเดต ${fmtTime(new Date(d.updated))}${stale ? ' (ข้อมูลอาจไม่ล่าสุด)' : ''} · รีเฟรชทุก 15 นาที`;
      renderCity(); drawMap(); renderMe(); renderLatest();
      // ครั้งแรก: ซูมให้เห็นจุดน้ำท่วมใหม่ทั้งหมดพอดีกรอบ (ถ้ายังไม่ได้ดูรอบตัว)
      if (!fitted && !me) { const f = pts().filter((p) => p.fresh); if (f.length) { map.fitBounds(L.latLngBounds(f.map((p) => [p.la, p.lo])).pad(0.08), { maxZoom: 13 }); fitted = true; } }
    } catch (e) {
      $('updated').textContent = 'โหลดข้อมูลไม่สำเร็จ';
      $('cityLine').innerHTML = `โหลดข้อมูลสรุปไม่สำเร็จ (${esc(e.message)}) · <a href="details.html">ดูหน้ารายละเอียด</a>`;
      initMap();
    }
  }
  load();
  setInterval(load, F.REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && H && Date.now() - new Date(H.updated) > 20 * 6e4) load(); });
})();
