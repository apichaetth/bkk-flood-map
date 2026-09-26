/* หน้าเฉพาะเรื่องแจ้งน้ำท่วมจาก Traffy Fondue (หน้าทดลอง แยกจากหน้าหลัก) */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, isoDate, fmtDT, ago, num, inBkk, cssVar } = F;

  const API = 'https://publicapi.traffy.in.th/share/teamchadchart/search';
  const TIMES = [[3, '3 ชม.'], [6, '6 ชม.'], [24, '24 ชม.'], [48, '48 ชม.'], [168, '7 วัน']];
  const STATES = [['all', 'ทั้งหมด'], ['open', 'ยังไม่เสร็จ'], ['wait', 'รอรับเรื่อง'], ['work', 'กำลังดำเนินการ'], ['done', 'เสร็จสิ้น']];
  const HOT_CELL_M = 500;
  const PAGE = 30;
  const stateGroup = (s) => (s === 'เสร็จสิ้น' ? 'done' : s === 'รอรับเรื่อง' ? 'wait' : 'work');

  let all = [], geo = null, oldest = null;
  let fTime = 24, fState = 'all', shown = PAGE;
  try { const v = JSON.parse(localStorage.getItem('bkkflood.traffyFilter') || 'null'); if (v) { fTime = v.t || fTime; fState = v.s || fState; } } catch (e) { /* ใช้ค่าเริ่มต้น */ }

  // ---------- ดึงข้อมูล ----------
  let rawCount = 0;
  // ดึง n เรื่องล่าสุด แล้วคัดเฉพาะเรื่องน้ำท่วม
  async function fetchN(n, ms) {
    const d = await F.getJSON(API + '?limit=' + n, ms);
    if (!Array.isArray(d.results) || !d.results.length) throw new Error('Traffy ส่งข้อมูลว่างกลับมา');
    const times = d.results.map((r) => isoDate(r.timestamp)).filter(Boolean);
    return {
      raw: d.results.length,
      oldest: times.length ? new Date(Math.min(...times)) : null,
      items: d.results
        .map((r) => ({ r, t: isoDate(r.timestamp), lo: num(r.coords && r.coords[0]), la: num(r.coords && r.coords[1]) }))
        .filter((x) => x.la && x.lo && x.t && inBkk(x.la, x.lo) && F.isFloodTicket(x.r))
        .map((x) => ({ ...x, ...F.levelFromText(x.r.description), g: stateGroup(x.r.state) }))
        .sort((a, b) => b.t - a.t),
    };
  }
  const filtered = () => {
    const cut = Date.now() - fTime * 36e5;
    return all.filter((x) => x.t >= cut && (fState === 'all' || (fState === 'open' ? x.g !== 'done' : x.g === fState)));
  };

  // ---------- แผนที่ ----------
  const map = L.map('tmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 18 }).setView([13.75, 100.56], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const hotLayer = L.layerGroup().addTo(map), ptLayer = L.layerGroup().addTo(map);
  $('showPts').onchange = (e) => (e.target.checked ? map.addLayer(ptLayer) : map.removeLayer(ptLayer));
  const colorOf = (x) => (x.g === 'done' ? cssVar('--stale') : cssVar(F.LEVEL[x.lv].color.slice(4, -1)));

  // รวมเรื่องที่อยู่ห่างกันไม่เกิน ~500 ม. เป็นกลุ่มเดียว เพื่อไฮไลท์บริเวณที่มีคนแจ้งหนาแน่น (ไม่ให้วงซ้อนกัน)
  function hotspots(list) {
    const groups = [];
    for (const x of list) {
      let best = null, bd = Infinity;
      for (const g of groups) { const d = F.distKm(g.la, g.lo, x.la, x.lo) * 1000; if (d < bd) { bd = d; best = g; } }
      if (best && bd <= HOT_CELL_M) {
        best.items.push(x);
        best.la += (x.la - best.la) / best.items.length; best.lo += (x.lo - best.lo) / best.items.length;
      } else groups.push({ la: x.la, lo: x.lo, items: [x] });
    }
    return groups.filter((g) => g.items.length >= 2)
      .map((g) => ({ ...g, open: g.items.filter((x) => x.g !== 'done').length }))
      .sort((a, b) => b.items.length - a.items.length);
  }
  function popupOf(x) {
    const r = x.r;
    return `<div class="pp">${F.badge(x.lv)} <span class="m">${esc(r.state || '')} · ประชาชนแจ้ง</span>
      <div style="margin-top:6px">${esc((r.description || '').slice(0, 300))}</div>
      ${r.photo_url ? `<img loading="lazy" src="${esc(r.photo_url)}" alt="ภาพจากผู้แจ้ง" referrerpolicy="no-referrer">` : ''}
      <div class="m" style="margin-top:6px">${esc(r.address || '')}<br>แจ้งเมื่อ ${fmtDT(x.t)} (${ago(x.t)})<br>
      <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.ticket_id)}" target="_blank" rel="noopener">เปิดใน Traffy (${esc(r.ticket_id)})</a></div></div>`;
  }
  function drawMap(list, hots) {
    hotLayer.clearLayers(); ptLayer.clearLayers();
    const red = cssVar('--critical');
    const max = Math.max(2, ...hots.map((h) => h.items.length));
    for (const h of hots) {
      const k = h.items.length / max;
      L.circle([h.la, h.lo], { radius: 250 + 250 * k, color: red, weight: 1.5, fillColor: red, fillOpacity: 0.12 + 0.3 * k, interactive: false }).addTo(hotLayer);
      L.marker([h.la, h.lo], { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="tf-count">${h.items.length}</div>` }), zIndexOffset: 1000 })
        .bindPopup(`<div class="pp"><h3>มีคนแจ้ง ${h.items.length} เรื่องในบริเวณนี้</h3><div class="m">ยังไม่เสร็จ ${h.open} เรื่อง · ล่าสุด ${ago(h.items[0].t)}</div>
          <ul class="plist">${h.items.slice(0, 6).map((x) => `<li>${esc((x.r.description || '').slice(0, 70))}</li>`).join('')}</ul></div>`)
        .addTo(hotLayer);
    }
    for (const x of list) {
      L.circleMarker([x.la, x.lo], { radius: x.g === 'done' ? 4 : 6, color: '#fff', weight: 1.5, fillColor: colorOf(x), fillOpacity: x.g === 'done' ? 0.6 : 0.95 })
        .bindPopup(popupOf(x), { maxWidth: 300 }).addTo(ptLayer);
    }
  }

  // ---------- กราฟรายชั่วโมง (แท่งเดียว สีเดียว มี tooltip) ----------
  function drawChart(list) {
    const hours = Math.min(fTime, 48);
    const now = Date.now(), start = now - hours * 36e5;
    const bins = new Array(hours).fill(0);
    for (const x of list) { const i = Math.floor((x.t - start) / 36e5); if (i >= 0 && i < hours) bins[i]++; }
    const W = 720, H = 180, pad = { l: 28, r: 8, t: 10, b: 24 };
    const max = Math.max(1, ...bins);
    const bw = (W - pad.l - pad.r) / hours;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
    const hh = (i) => new Intl.DateTimeFormat('th-TH', { timeZone: F.TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(start + i * 36e5));
    const step = Math.ceil(hours / 8);
    $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join('')}
      ${bins.map((v, i) => `<g><title>${hh(i)}–${hh(i + 1)} น.: ${v} เรื่อง</title>
        <rect x="${pad.l + i * bw + 1}" y="${pad.t}" width="${Math.max(1, bw - 2)}" height="${H - pad.t - pad.b}" class="hit"/>
        ${v ? `<rect x="${pad.l + i * bw + 1}" y="${y(v)}" width="${Math.max(1, bw - 2)}" height="${H - pad.b - y(v)}" rx="${Math.min(3, bw / 4)}" class="bar"/>` : ''}</g>`).join('')}
      ${bins.map((_, i) => (i % step === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" class="ax" text-anchor="middle">${hh(i)}</text>` : '')).join('')}
    </svg>`;
    $('chartNote').textContent = `${hours} ชม. ล่าสุด · ชั่วโมงที่แจ้งมากที่สุด ${max} เรื่อง`;
  }

  // ---------- จัดอันดับเขต ----------
  function drawRank(list) {
    const m = new Map();
    for (const x of list) {
      const d = (geo && F.districtAt(geo, x.la, x.lo)) || (String(x.r.address || '').match(/เขต\s*([^\s,]+)/) || [])[1] || 'ไม่ทราบเขต';
      x.district = d;
      m.set(d, (m.get(d) || 0) + 1);
    }
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max = rows.length ? rows[0][1] : 1;
    $('dRank').innerHTML = rows.length ? rows.map(([d, n]) => `<li><span class="dn">เขต${esc(d)}</span><span class="bar-wrap"><span class="bar-in" style="width:${(100 * n) / max}%"></span></span><span class="dv">${n}</span></li>`).join('')
      : '<li class="muted">ไม่มีเรื่องแจ้งในช่วงนี้</li>';
  }

  // ---------- รายการ ----------
  function drawList(list) {
    $('listCount').textContent = `${list.length} เรื่อง`;
    $('list').innerHTML = list.length ? list.slice(0, shown).map((x) => {
      const r = x.r;
      return `<article class="tf-item ${x.g}">
        ${r.photo_url ? `<img loading="lazy" src="${esc(r.photo_url)}" alt="" referrerpolicy="no-referrer">` : '<div class="noimg">ไม่มีรูป</div>'}
        <div class="tf-body">
          <div class="t-row">${F.badge(x.lv)}<span class="st st-${x.g}">${esc(r.state || '')}</span><span class="muted small">${fmtDT(x.t)} · ${ago(x.t)}</span></div>
          <p>${esc((r.description || '').slice(0, 220))}</p>
          <p class="muted small">${esc(r.address || '')}${x.district ? ` · เขต${esc(x.district)}` : ''}</p>
          <div class="small"><a href="#" data-go="${x.la},${x.lo}">ดูบนแผนที่</a> · <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.ticket_id)}" target="_blank" rel="noopener">เปิดใน Traffy</a></div>
        </div></article>`;
    }).join('') : `<p class="muted">ไม่มีเรื่องแจ้งน้ำท่วมในช่วงเวลาและสถานะที่เลือก${all.length ? ` (ทั้งหมดที่ดึงได้มี ${all.length} เรื่อง ลองเลือกช่วงเวลาให้ยาวขึ้น)` : rawCount ? ` (จาก ${rawCount} เรื่องล่าสุดใน Traffy ยังไม่มีเรื่องน้ำท่วม)` : ''}</p>`;
    $('more').hidden = list.length <= shown;
    $('list').querySelectorAll('[data-go]').forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      const [la, lo] = a.dataset.go.split(',').map(Number);
      map.setView([la, lo], 16);
      $('tmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ---------- ตัวกรอง + แสดงผลทั้งหมด ----------
  function chips(id, opts, cur, set) {
    $(id).innerHTML = opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}" aria-pressed="${String(v) === String(cur)}">${t}</button>`).join('');
    $(id).querySelectorAll('button').forEach((b) => b.onclick = () => { set(b.dataset.v); render(); });
  }
  function render() {
    chips('fTime', TIMES, fTime, (v) => { fTime = +v; shown = PAGE; });
    chips('fState', STATES, fState, (v) => { fState = v; shown = PAGE; });
    try { localStorage.setItem('bkkflood.traffyFilter', JSON.stringify({ t: fTime, s: fState })); } catch (e) { /* ไม่เป็นไร */ }
    const list = filtered();
    const hots = hotspots(list);
    const inTime = all.filter((x) => x.t >= Date.now() - fTime * 36e5);
    $('kAll').textContent = list.length;
    $('kWait').textContent = inTime.filter((x) => x.g === 'wait').length;
    $('kWork').textContent = inTime.filter((x) => x.g === 'work').length;
    $('kDone').textContent = inTime.filter((x) => x.g === 'done').length;
    $('kHot').textContent = hots.length;
    drawMap(list, hots);
    drawChart(list);
    drawRank(list);
    drawList(list);
    const cut = Date.now() - fTime * 36e5;
    $('coverage').textContent = oldest ? `ข้อมูลที่ดึงได้ครอบคลุมเรื่องที่แจ้งตั้งแต่ ${fmtDT(oldest)}` + (oldest > cut ? ' (ไม่ถึงช่วงเวลาที่เลือก ตัวเลขอาจน้อยกว่าจริง)' : '') : '';
    if (hots.length) map.fitBounds(L.latLngBounds(hots.map((h) => [h.la, h.lo])).pad(0.3), { maxZoom: 14 });
    else if (list.length) map.fitBounds(L.latLngBounds(list.map((x) => [x.la, x.lo])).pad(0.2), { maxZoom: 14 });
  }
  $('more').onclick = () => { shown += PAGE; drawList(filtered()); };

  // โหลด 500 เรื่องก่อน (เร็วกว่า) แสดงผลทันที แล้วค่อยดึง 1000 เรื่องเบื้องหลังเพื่อให้ย้อนหลังได้ไกลขึ้น
  // เก็บผลล่าสุดไว้ในเบราว์เซอร์ ครั้งหน้าเปิดแล้วแสดงได้ทันที (เก็บเฉพาะเรื่องน้ำท่วม + ฟิลด์ที่ใช้ เพื่อไม่ให้ใหญ่)
  const CACHE = 'bkkflood.traffyCache';
  const CACHE_MAX_H = 72;
  function saveCache() {
    const slim = all.map((x) => ({
      r: { ticket_id: x.r.ticket_id, description: String(x.r.description || '').slice(0, 400), address: x.r.address, state: x.r.state, photo_url: x.r.photo_url },
      t: x.t.getTime(), la: x.la, lo: x.lo, lv: x.lv, why: x.why, cm: x.cm, g: x.g,
    }));
    try { localStorage.setItem(CACHE, JSON.stringify({ saved: Date.now(), raw: rawCount, oldest: oldest && oldest.getTime(), items: slim })); } catch (e) { /* พื้นที่เต็ม/ปิดไว้ ไม่เป็นไร */ }
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (!c || Date.now() - c.saved > CACHE_MAX_H * 36e5) return null;
      return { saved: new Date(c.saved), raw: c.raw, oldest: c.oldest ? new Date(c.oldest) : null, items: c.items.map((x) => ({ ...x, t: new Date(x.t) })) };
    } catch (e) { return null; }
  }
  let cachedAt = null;

  let loading = 0;
  const status = () => `ดึงจาก Traffy ${rawCount} เรื่องล่าสุด เป็นเรื่องน้ำท่วม ${all.length} เรื่อง`;
  async function load() {
    const my = ++loading, t0 = Date.now();
    const tick = setInterval(() => {
      if (my !== loading) return;
      const sec = Math.round((Date.now() - t0) / 1000);
      $('updated').textContent = cachedAt
        ? `แสดงข้อมูลที่บันทึกไว้เมื่อ ${fmtDT(cachedAt)} (${ago(cachedAt)}) · กำลังโหลดข้อมูลใหม่… ${sec} วินาที`
        : `กำลังโหลดจาก Traffy Fondue… ${sec} วินาที (Traffy อาจตอบช้าช่วงมีคนใช้มาก)`;
    }, 1000);
    try {
      geo = geo || await F.loadDistricts().catch(() => null);
      const first = await fetchN(500, 90000);
      if (my !== loading) return;
      ({ items: all, raw: rawCount, oldest } = first);
      cachedAt = null;
      clearInterval(tick); // ได้ข้อมูลแล้ว หยุดตัวนับเวลารอ
      render(); saveCache();
      $('updated').textContent = `อัปเดต ${fmtDT(new Date())} · ${status()} · กำลังดึงเพิ่มเพื่อย้อนหลังให้ไกลขึ้น…`;
      try {
        const more = await fetchN(1000, 90000);
        if (my === loading && more.raw > rawCount) { ({ items: all, raw: rawCount, oldest } = more); render(); saveCache(); }
      } catch (e) { /* ใช้ 500 เรื่องที่ได้แล้ว */ }
      if (my === loading) $('updated').textContent = `อัปเดต ${fmtDT(new Date())} · ${status()} · รีเฟรชทุก 15 นาที`;
    } catch (e) {
      if (my !== loading) return;
      if (cachedAt) { $('updated').textContent = `โหลดข้อมูลใหม่ไม่สำเร็จ (${e.message}) · แสดงข้อมูลที่บันทึกไว้เมื่อ ${fmtDT(cachedAt)} · กด รีเฟรช เพื่อลองใหม่`; return; }
      $('updated').textContent = 'โหลดไม่สำเร็จ: ' + e.message + ' (กด รีเฟรช เพื่อลองใหม่)';
      $('list').innerHTML = `<p>ดึงข้อมูลจาก Traffy ไม่สำเร็จ (${esc(e.message)}) กด รีเฟรช เพื่อลองใหม่</p>`;
    } finally { clearInterval(tick); }
  }
  $('refresh').onclick = load;
  setInterval(load, F.REFRESH_MS);
  // มีข้อมูลที่บันทึกไว้ -> แสดงทันที แล้วค่อยโหลดใหม่เบื้องหลัง
  const c = loadCache();
  if (c) { ({ items: all, raw: rawCount, oldest } = c); cachedAt = c.saved; }
  render(); // แสดงตัวกรองและโครงหน้าทันที ระหว่างรอข้อมูล
  if (c) $('updated').textContent = `แสดงข้อมูลที่บันทึกไว้เมื่อ ${fmtDT(cachedAt)} (${ago(cachedAt)}) · กำลังโหลดข้อมูลใหม่…`;
  load();
})();
