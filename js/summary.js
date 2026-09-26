/* หน้าสรุป: รวมทุกแหล่งเป็น "จุดน้ำท่วม" (รวมรายงานที่ห่างกันไม่เกิน 500 ม.) แล้วแสดง 3 แบบ
 * ภาพรวม + แผนที่เขต/ถนนสีแดง, 10 จุดที่น่าห่วงที่สุด, แยกตามเขต และรายการทุกจุด
 */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT, fmtTime, ago, distKm, th, cssVar, store } = F;

  const CLUSTER_KM = 0.5;
  const ROAD_MATCH_M = 40; // ถนนที่อยู่ห่างจากจุดรายงานไม่เกินนี้ถือว่าเป็นถนนของจุดนั้น
  const ROAD_SPAN_M = 300; // ระบายสีถนนยาวออกไปจากจุดรายงานไม่เกินนี้
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const ROAD_CACHE = 'bkkflood.roads';

  // ระดับของจุด: 3 = ยืนยันแล้ว, 2 = มีรายงาน, 1 = เสี่ยง
  const TIER = {
    3: { label: 'ยืนยันแล้ว', long: 'น้ำท่วม (ยืนยันแล้ว)' },
    2: { label: 'มีรายงาน', long: 'มีรายงานน้ำท่วม' },
    1: { label: 'เสี่ยง', long: 'เสี่ยงน้ำท่วม' },
  };
  const SRC = {
    sensor: 'เซ็นเซอร์ กทม.', itic: 'หน่วยงาน/iTIC', web: 'ประชาชนปักหมุด', traffy: 'ประชาชนแจ้ง (Traffy)',
    news: 'ข่าว', youtube: 'คลิป YouTube', rain: 'ฝนหนัก', wl: 'ระดับน้ำสูง',
  };
  const tag = (tier) => `<span class="tag t${tier}">${TIER[tier].label}</span>`;
  const mapLink = (c) => `map.html?lat=${c.la.toFixed(5)}&lng=${c.lo.toFixed(5)}&z=16`;

  // ---------- 1) แปลงข้อมูลทุกแหล่งเป็น "สัญญาณ" ----------
  function signals(D) {
    const out = [];
    for (const x of D.sensor || []) if (x.lv > 0) {
      out.push({ la: x.la, lo: x.lo, src: 'sensor', tier: 3, name: x.s.name || x.s.road, detail: `วัดได้ ${Math.round(x.cm)} ซม.`, cm: x.cm, t: x.t, district: x.s.district });
    }
    for (const x of D.event || []) {
      out.push({ la: x.la, lo: x.lo, src: 'itic', tier: 3, name: String(x.e.title || '').replace(/^น้ำท่วม\s*/, ''), detail: x.why, cm: x.cm || 0, t: x.start });
    }
    for (const x of D.traffy || []) {
      out.push({ la: x.la, lo: x.lo, src: 'traffy', tier: 2, name: String(x.r.address || 'จุดที่ประชาชนแจ้ง').split(/\s+(?:แขวง|เขต)/)[0], detail: x.why, cm: x.cm || 0, t: x.t,
        link: `https://share.traffy.in.th/teamchadchart/${encodeURIComponent(x.r.ticket_id)}` });
    }
    for (const x of D.web || []) {
      out.push({ la: x.la, lo: x.lo, src: 'web', tier: 2, name: x.r.place || 'จุดที่ประชาชนปักหมุด', detail: `น้ำระดับ${x.r.level}${x.r.message ? ' · ' + x.r.message : ''}`, cm: 0, t: x.t,
        link: 'log.html?report=' + encodeURIComponent(x.r.id) });
    }
    for (const n of D.news || []) {
      if ((F.SEV_LV[n.severity] || 2) < 2) continue; // ข่าวเตือนภัย/น้ำลดแล้ว ไม่นับเป็นจุดน้ำท่วม
      for (const p of n.pins || []) if (p.precision === 'place') {
        out.push({ la: p.lat, lo: p.lng, src: n.kind === 'youtube' ? 'youtube' : 'news', tier: 2, name: p.label, detail: `${n.source}: ${n.title}`, cm: 0, t: new Date(n.published), link: n.link, district: p.district });
      }
    }
    for (const s of D.rain || []) if (s.mm > F.RAIN_HEAVY_MM) {
      out.push({ la: s.la, lo: s.lo, src: 'rain', tier: 1, name: 'สถานีฝน ' + th(s.x.station.tele_station_name), detail: `ฝน ${s.mm} มม. ใน 24 ชม.`, cm: 0, t: s.t, radius: 350, mm: s.mm, district: th(s.x.geocode && s.x.geocode.amphoe_name) });
    }
    for (const s of D.wl || []) if (!s.stale && s.pct != null && s.pct >= 90) {
      out.push({ la: s.la, lo: s.lo, src: 'wl', tier: 1, name: th(s.x.station.tele_station_name), detail: `ระดับน้ำ ${s.pct.toFixed(0)}% ของตลิ่ง`, cm: 0, t: s.t, radius: 250, pct: s.pct });
    }
    return out;
  }

  // ---------- 2) รวมสัญญาณที่อยู่ใกล้กันเป็นจุดเดียว ----------
  const NAME_RANK = { sensor: 0, itic: 1, news: 2, youtube: 3, web: 4, traffy: 5, wl: 6, rain: 7 };
  function cluster(sig, geo) {
    const sorted = [...sig].sort((a, b) => b.tier - a.tier || (b.t || 0) - (a.t || 0));
    const cl = [];
    for (const s of sorted) {
      const hit = cl.find((c) => distKm(c.la, c.lo, s.la, s.lo) <= CLUSTER_KM);
      if (hit) hit.members.push(s);
      else cl.push({ la: s.la, lo: s.lo, members: [s] });
    }
    for (const c of cl) {
      const reports = c.members.filter((m) => m.tier >= 2);
      c.sources = [...new Set(reports.map((m) => m.src))];
      const maxTier = Math.max(...c.members.map((m) => m.tier));
      // รายงานจาก 2 แหล่งขึ้นไป (เช่น Traffy + ข่าว) ถือว่ายืนยันแล้ว
      c.tier = maxTier >= 2 && c.sources.length >= 2 ? 3 : maxTier;
      const best = [...c.members].sort((a, b) => NAME_RANK[a.src] - NAME_RANK[b.src])[0];
      c.name = best.name || 'ไม่ระบุชื่อ';
      c.cm = Math.max(0, ...c.members.map((m) => m.cm || 0));
      c.t = c.members.reduce((t, m) => (m.t && (!t || m.t > t) ? m.t : t), null);
      c.district = (geo && F.districtAt(geo, c.la, c.lo)) || c.members.map((m) => m.district).find(Boolean) || '';
      c.score = c.tier * 1000 + c.sources.length * 100 + c.cm;
    }
    return cl.sort((a, b) => b.score - a.score || (b.t || 0) - (a.t || 0));
  }

  // ---------- 3) สรุปรายเขต ----------
  function byDistrict(clusters, news) {
    const m = new Map();
    const get = (name) => { if (!m.has(name)) m.set(name, { name, 3: 0, 2: 0, 1: 0, news: 0, clusters: [] }); return m.get(name); };
    for (const c of clusters) if (c.district) { const d = get(c.district); d[c.tier]++; d.clusters.push(c); }
    // ข่าวที่ระบุได้แค่ระดับเขต นับเป็น "มีรายงาน" ของเขตนั้น
    for (const n of news || []) if ((F.SEV_LV[n.severity] || 2) >= 2) {
      for (const p of n.pins || []) if (p.precision === 'district' && p.district) get(p.district).news++;
    }
    for (const d of m.values()) {
      d.level = d[3] ? 3 : d[2] || d.news ? 2 : d[1] ? 1 : 0;
      d.score = d[3] * 100 + d[2] * 10 + d.news * 5 + d[1];
    }
    return [...m.values()].filter((d) => d.level).sort((a, b) => b.level - a.level || b.score - a.score);
  }

  // ---------- แผนที่ ----------
  const map = L.map('smap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 17 }).setView([13.75, 100.6], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.createPane('roads').style.zIndex = 450;
  F.addLocate(map, () => { userMoved = true; }); // ผู้ใช้ไปดูตำแหน่งตัวเองแล้ว ไม่ต้องซูมอัตโนมัติทับ
  const lyr = { districts: L.layerGroup().addTo(map), risk: L.layerGroup().addTo(map), areas: L.layerGroup().addTo(map), roads: L.layerGroup().addTo(map), spots: L.layerGroup().addTo(map), web: L.layerGroup().addTo(map) };
  // พื้นที่เสี่ยงแสดงเป็นค่าเริ่มต้น ยกเลิกติ๊กเพื่อซ่อน
  $('showRisk').onchange = (e) => { if (e.target.checked) map.addLayer(lyr.risk); else map.removeLayer(lyr.risk); };
  // ยกเลิกติ๊กเพื่อดูเฉพาะถนนที่ไฮไลท์สีแดง (ซ่อนจุด วงบริเวณ และหมุดประชาชน)
  $('showSpots').onchange = (e) => ['spots', 'areas', 'web'].forEach((k) => (e.target.checked ? map.addLayer(lyr[k]) : map.removeLayer(lyr[k])));

  // ---------- เรดาร์ฝน (RainViewer) + กล้อง CCTV สาธารณะ ----------
  lyr.radar = L.layerGroup().addTo(map);
  lyr.cam = L.layerGroup().addTo(map);
  $('showRadar').onchange = (e) => (e.target.checked ? map.addLayer(lyr.radar) : map.removeLayer(lyr.radar));
  $('showCam').onchange = (e) => (e.target.checked ? map.addLayer(lyr.cam) : map.removeLayer(lyr.cam));
  async function loadRadar() {
    try {
      const d = await F.fetchRadar();
      const f = d.radar && d.radar.past && d.radar.past[d.radar.past.length - 1];
      if (!f) { $('radarSt').textContent = '(ไม่มีภาพเรดาร์)'; return; }
      lyr.radar.clearLayers();
      L.tileLayer(d.host + f.path + '/256/{z}/{x}/{y}/2/1_1.png', { opacity: 0.45, maxNativeZoom: 7, maxZoom: 19, zIndex: 5, attribution: 'เรดาร์ © RainViewer' }).addTo(lyr.radar);
      // เรดาร์แสดงเฉพาะบริเวณที่มีฝน ถ้าไม่มีฝนแผนที่จะดูเหมือนไม่มีอะไร
      $('radarSt').textContent = `(ภาพเวลา ${fmtTime(new Date(f.time * 1000))} · มีสีเฉพาะที่ฝนตก)`;
    } catch (e) { $('radarSt').textContent = '(โหลดไม่ได้: ' + e.message + ')'; }
  }
  let hls = null;
  const stopStream = () => { if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; } };
  function startStream(el, c) {
    stopStream();
    const v = el.querySelector('video'), st = el.querySelector('.camst');
    const fail = (why) => { v.remove(); st.textContent = 'ภาพสดใช้ไม่ได้ขณะนี้ (' + why + ')'; };
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 1 });
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stopStream(); fail(d.details || 'error'); } });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { st.textContent = '● ภาพสด'; });
      hls.loadSource(c.hls_url); hls.attachMedia(v); v.play().catch(() => {});
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = c.hls_url; v.onplaying = () => { st.textContent = '● ภาพสด'; }; v.onerror = () => fail('error'); v.play().catch(() => {});
    } else fail('เบราว์เซอร์ไม่รองรับ');
  }
  async function loadCams() {
    try {
      const d = await F.fetchCams();
      if (!Array.isArray(d)) { $('camSt').textContent = '(รูปแบบข้อมูลไม่ถูกต้อง)'; return; }
      lyr.cam.clearLayers();
      // เฉพาะกล้องที่เผยแพร่สาธารณะผ่าน HTTPS และยังไม่ถูกระงับ
      for (const c of d) {
        const la = F.num(c.latitude), lo = F.num(c.longitude);
        if (!la || !lo || !F.inBkk(la, lo) || !/^https:\/\//.test(c.hls_url || '') || /tempsus/.test(c.hls_url)) continue;
        L.marker([la, lo], { icon: mkIcon('cam', '#1d2330', '▶', 12), zIndexOffset: -100 })
          .bindPopup(() => `<div class="pp" style="width:290px;max-width:100%"><div class="m">${esc(c.organization || '')} · ${esc(c.camid)}</div><h3>${esc(c.title)}</h3>
            <video muted autoplay playsinline controls></video><div class="m camst">กำลังเชื่อมต่อ…</div>
            <div class="m">ภาพจาก ${esc(c.sponsertext || c.organization || 'iTIC')} ผ่าน iTIC / Longdo</div></div>`, { maxWidth: 310, minWidth: 250 })
          .on('popupopen', (e) => startStream(e.popup.getElement(), c))
          .on('popupclose', stopStream)
          .addTo(lyr.cam);
      }
      $('camSt').textContent = `(${lyr.cam.getLayers().length} กล้อง · กดดูภาพสด)`;
    } catch (e) { $('camSt').textContent = '(โหลดไม่ได้: ' + e.message + ')'; }
  }

  // ให้ js/report.js ใช้แผนที่หน้านี้สำหรับปักหมุดแจ้งน้ำท่วม/น้ำลด (ไม่ต้องไปหน้าแผนที่ละเอียด)
  const mkIcon = (cls, color, text = '', size = 18, extra = '') => {
    size = Math.max(5, Math.round(size * F.MS));
    if (size < 14) text = '';
    const hit = Math.max(size, 22);
    return L.divIcon({
      className: '', iconSize: [hit, hit], iconAnchor: [hit / 2, hit / 2], popupAnchor: [0, -size / 2],
      html: `<div class="mkhit" style="width:${hit}px;height:${hit}px"><div class="mk ${cls} ${extra}" style="--c:${color};width:${size}px;height:${size}px">${text}</div></div>`,
    });
  };
  window.FloodMap = {
    map, layers: { web: lyr.web }, setFeed: () => {}, icon: mkIcon,
    buttons: { report: $('btnReport'), close: $('btnClose') },
    onChange: () => refresh(),
  };

  const RED = () => ({ 3: cssVar('--flood3'), 2: cssVar('--flood2'), 1: cssVar('--flood1') });
  function drawDistricts(geo, dists) {
    lyr.districts.clearLayers();
    if (!geo) return;
    const lvl = new Map(dists.map((d) => [d.name, d]));
    L.geoJSON(geo, {
      style: (f) => {
        // ไม่ระบายสีเขต (ดูสับสน) แสดงเฉพาะเส้นขอบบาง ๆ ให้รู้ตำแหน่ง
        return { color: '#7d8896', weight: 1, opacity: 0.45, dashArray: '3 3', fill: true, fillOpacity: 0 };
      },
      onEachFeature: (f, layer) => {
        const d = lvl.get(f.properties.name);
        layer.bindTooltip(`<b>เขต${esc(f.properties.name)}</b><br>` + (d
          ? `ยืนยัน ${d[3]} · มีรายงาน ${d[2] + d.news} · เสี่ยง ${d[1]}` : 'ไม่มีรายงาน'), { sticky: true });
      },
    }).addTo(lyr.districts);
  }
  function drawSpots(clusters) {
    lyr.spots.clearLayers(); lyr.areas.clearLayers(); lyr.risk.clearLayers();
    const red = RED();
    for (const c of clusters) {
      const popup = `<div class="pp">${tag(c.tier)}<h3>${esc(c.name)}</h3><div class="m">เขต${esc(c.district || '–')} · ${c.t ? fmtDT(c.t) : ''}</div>
        <ul class="plist">${c.members.slice(0, 5).map((m) => `<li><b>${SRC[m.src]}</b> ${esc(m.detail)}</li>`).join('')}</ul>
        <a href="${mapLink(c)}">ดูบนแผนที่ละเอียด →</a></div>`;
      if (c.tier === 1) {
        const r = Math.max(...c.members.map((m) => m.radius || 250));
        // มือถือเห็นทั้งเมืองในจอเล็ก วงรัศมีเป็นเมตรจึงดูใหญ่ ย่อครึ่งหนึ่ง
        L.circle([c.la, c.lo], { radius: r * F.MS, color: red[3], weight: F.MS < 1 ? 1 : 1.5, dashArray: F.MS < 1 ? '3 3' : '5 5', fillColor: red[3], fillOpacity: 0.1 }).bindPopup(popup).addTo(lyr.risk);
      } else {
        // หมุดที่ประชาชนปักอย่างเดียว วาดโดย report.js (มีปุ่มน้ำลดแล้ว) ไม่ต้องวาดซ้ำ
        if (c.sources.length === 1 && c.sources[0] === 'web' && c.members.every((m) => m.src === 'web' || m.tier === 1)) continue;
        // บริเวณรอบจุด (เผื่อไม่มีข้อมูลถนน) + จุด
        L.circle([c.la, c.lo], { radius: 120 * F.MS, stroke: false, fillColor: red[3], fillOpacity: c.tier === 3 ? 0.18 : 0.12, interactive: false }).addTo(lyr.areas);
        L.circleMarker([c.la, c.lo], { radius: c.tier === 3 ? 9 : 7, color: '#fff', weight: 2, fillColor: red[c.tier], fillOpacity: 1 }).bindPopup(popup).addTo(lyr.spots);
      }
    }
  }

  // ---------- ถนนสีแดง (OpenStreetMap ผ่าน Overpass API) ----------
  const mDist = (la1, lo1, la2, lo2) => distKm(la1, lo1, la2, lo2) * 1000;
  function densify(geom, stepM = 25) {
    const out = [];
    for (let i = 0; i < geom.length - 1; i++) {
      const a = geom[i], b = geom[i + 1];
      const n = Math.max(1, Math.ceil(mDist(a.lat, a.lon, b.lat, b.lon) / stepM));
      for (let k = 0; k < n; k++) out.push([a.lat + ((b.lat - a.lat) * k) / n, a.lon + ((b.lon - a.lon) * k) / n]);
    }
    if (geom.length) out.push([geom[geom.length - 1].lat, geom[geom.length - 1].lon]);
    return out;
  }
  async function fetchRoads(spots) {
    const key = spots.map((c) => c.la.toFixed(4) + ',' + c.lo.toFixed(4)).join(';');
    const cached = store.get(ROAD_CACHE);
    if (cached && cached.key === key && Date.now() - cached.t < 30 * 60e3) return cached.lines;
    const hw = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';
    const q = `[out:json][timeout:25];(${spots.map((c) => `way(around:${ROAD_MATCH_M},${c.la},${c.lo})[highway~"${hw}"];`).join('')});out geom;`;
    let data = null, lastErr = null;
    for (const url of OVERPASS) {
      try {
        data = await F.getJSON(url, 35000, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        break;
      } catch (e) { lastErr = e; }
    }
    // เซิร์ฟเวอร์ถนนล่มทุกแห่ง: ใช้เส้นถนนชุดล่าสุดที่เคยวาดไว้ (ไม่เกิน 6 ชม.) ดีกว่าไม่มีเลย
    if (!data) { if (cached && Date.now() - cached.t < 6 * 36e5) return cached.lines; throw lastErr; }
    const lines = [];
    for (const w of data.elements || []) {
      if (!w.geometry || w.geometry.length < 2) continue;
      const pts = densify(w.geometry);
      for (const c of spots) {
        // ถนนเส้นนี้ต้องผ่านใกล้จุดรายงานจริง แล้วระบายเฉพาะช่วงที่อยู่ในรัศมี ROAD_SPAN_M
        if (!pts.some((p) => mDist(p[0], p[1], c.la, c.lo) <= ROAD_MATCH_M + 15)) continue;
        let run = [];
        const flush = () => { if (run.length >= 2) lines.push({ tier: c.tier, pts: run.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) }); run = []; };
        for (const p of pts) { if (mDist(p[0], p[1], c.la, c.lo) <= ROAD_SPAN_M) run.push(p); else flush(); }
        flush();
      }
    }
    store.set(ROAD_CACHE, { key, t: Date.now(), lines });
    return lines;
  }
  async function drawRoads(clusters, my) {
    lyr.roads.clearLayers();
    const spots = clusters.filter((c) => c.tier >= 2).slice(0, 60);
    if (!spots.length) { $('roadNote').textContent = ''; return; }
    $('roadNote').textContent = 'กำลังโหลดเส้นถนนบริเวณจุดน้ำท่วม…';
    try {
      const lines = await fetchRoads(spots);
      if (my !== undefined && my !== gen) return; // มีรอบรีเฟรชใหม่แล้ว ไม่วาดซ้อน
      lyr.roads.clearLayers();
      const red = RED();
      // วาดระดับต่ำก่อน ให้ถนนที่ยืนยันแล้วอยู่ด้านบน
      for (const l of lines.sort((a, b) => a.tier - b.tier)) {
        // ขอบขาวรองใต้เส้นแดง ให้เห็นชัดบนแผนที่ทุกสี
        L.polyline(l.pts, { pane: 'roads', color: '#fff', weight: l.tier === 3 ? 12 : 10, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(lyr.roads);
        L.polyline(l.pts, { pane: 'roads', color: red[l.tier], weight: l.tier === 3 ? 8 : 6, opacity: 1, dashArray: l.tier === 3 ? null : '12 8', lineCap: 'round', interactive: false }).addTo(lyr.roads);
      }
      $('roadNote').textContent = lines.length ? `ระบายสีแดงบนถนน ${lines.length} ช่วง ในรัศมีประมาณ ${ROAD_SPAN_M} ม. จากจุดที่มีรายงาน (ข้อมูลถนน © OpenStreetMap)` : 'ไม่พบเส้นถนนใกล้จุดรายงาน แสดงเป็นวงบริเวณแทน';
    } catch (e) {
      $('roadNote').textContent = 'โหลดเส้นถนนไม่สำเร็จ (' + e.message + ') แสดงเป็นวงบริเวณสีแดงแทน';
    }
  }

  // ---------- ส่วนแสดงผล ----------
  function sourceChips(c) {
    const chips = c.sources.map((s) => `<span class="chip">${SRC[s]}</span>`);
    const risk = c.members.filter((m) => m.tier === 1).map((m) => m.src);
    for (const r of new Set(risk)) chips.push(`<span class="chip soft">${SRC[r]}</span>`);
    return chips.join('');
  }
  function renderHeadline(clusters, dists, feeds) {
    const n3 = clusters.filter((c) => c.tier === 3).length, n2 = clusters.filter((c) => c.tier === 2).length, n1 = clusters.filter((c) => c.tier === 1).length;
    const flooded = dists.filter((d) => d.level >= 2);
    $('nConfirmed').textContent = n3; $('nReported').textContent = n2; $('nRisk').textContent = n1; $('nDistricts').textContent = flooded.length;
    const hero = document.querySelector('.hero');
    hero.dataset.level = n3 ? 3 : n2 ? 2 : n1 ? 1 : 0;
    const pending = feeds.filter((f) => f.pending).length;
    if (!n3 && !n2 && pending) {
      $('headline').textContent = n1 ? `พบพื้นที่เสี่ยง ${n1} จุด กำลังโหลดข้อมูลเพิ่ม…` : 'กำลังโหลดข้อมูล…';
      $('subline').textContent = `โหลดแล้ว ${feeds.length - pending}/${feeds.length} แหล่ง`;
    } else if (!n3 && !n2) {
      $('headline').textContent = n1 ? `ยังไม่พบรายงานน้ำท่วม แต่มี ${n1} พื้นที่เสี่ยง` : 'ขณะนี้ยังไม่พบรายงานน้ำท่วมใน กทม.';
      $('subline').textContent = n1 ? 'มีฝนตกหนักหรือระดับน้ำในคลองสูง โปรดติดตามสถานการณ์' : 'ข้อมูลจากทุกแหล่งยังไม่มีรายงานน้ำท่วมบนถนน';
    } else {
      $('headline').innerHTML = `พบจุดน้ำท่วม <em>${n3 + n2}</em> จุด ใน <em>${flooded.length}</em> เขต`;
      $('subline').textContent = 'เขตที่น่าห่วง: ' + flooded.slice(0, 5).map((d) => 'เขต' + d.name).join(', ') + (flooded.length > 5 ? ` และอีก ${flooded.length - 5} เขต` : '');
    }
    const ok = feeds.filter((f) => f.ok), down = feeds.filter((f) => !f.ok && !f.off && !f.pending);
    // เซ็นเซอร์ กทม. ล่มบ่อยช่วงฝนหนัก (ปัญหาที่เซิร์ฟเวอร์ต้นทาง) แจ้งแยกแบบไม่ตกใจ
    const bma = down.find((f) => f.key === 'sensor'), bad = down.filter((f) => f.key !== 'sensor');
    const msg = [];
    if (bad.length) msg.push(`ดึงข้อมูลไม่สำเร็จ ${bad.length} แหล่ง (${bad.map((f) => f.name).join(', ')}) ตัวเลขอาจน้อยกว่าความจริง`);
    if (bma) msg.push('ระบบเซ็นเซอร์ของ กทม. ไม่ตอบสนองขณะนี้ (ปัญหาที่ต้นทาง มักเกิดช่วงฝนหนัก) ใช้ข้อมูลจากแหล่งอื่นแทน จะลองใหม่ทุก 15 นาที');
    $('warn').hidden = !msg.length;
    $('warn').classList.toggle('soft', !bad.length);
    $('warn').textContent = msg.join(' · ');
    $('sources').textContent = `แหล่งข้อมูลที่ใช้ได้รอบนี้ ${ok.length}/${feeds.filter((f) => !f.off).length}: ${ok.map((f) => f.name).join(', ')} · รายละเอียดดูที่หน้าแผนที่ละเอียด แท็บ "แหล่งข้อมูล"`;
  }
  // แสดง 3 จุดแรกก่อน กด "ดูทั้ง 10 จุด" เพื่อขยาย
  let topOpen = false;
  function renderTop(clusters) {
    const top = clusters.filter((c) => c.tier >= 2).slice(0, 10);
    const show = topOpen ? top : top.slice(0, 3);
    $('top10').innerHTML = show.length ? show.map((c) => `<li><a href="${mapLink(c)}">
        <div class="t-row">${tag(c.tier)}<b>${esc(c.name)}</b></div>
        <div class="muted small">เขต${esc(c.district || '–')} · ${esc(String(c.members[0].detail || '').slice(0, 80))}${c.sources.length > 1 ? ` · ยืนยัน ${c.sources.length} แหล่ง` : ''} · ${c.t ? ago(c.t) : ''}</div>
      </a></li>`).join('') : '<li class="empty">ยังไม่มีจุดที่มีรายงานน้ำท่วม</li>';
    $('topNote').textContent = top.length ? `${show.length} จาก ${top.length} จุด` : '';
    $('topMore').hidden = top.length <= 3;
    $('topMore').textContent = topOpen ? 'ย่อเหลือ 3 จุด ▴' : `ดูทั้ง ${top.length} จุด ▾`;
    $('topMore').onclick = () => { topOpen = !topOpen; renderTop(clusters); };
  }
  function renderDistricts(dists) {
    $('districtList').innerHTML = dists.length ? dists.map((d) => `<details class="dist l${d.level}">
        <summary><span class="dname">เขต${esc(d.name)}</span>
          <span class="dcount">${d[3] ? `<span class="tag t3">ยืนยัน ${d[3]}</span>` : ''}${d[2] + d.news ? `<span class="tag t2">มีรายงาน ${d[2] + d.news}</span>` : ''}${d[1] ? `<span class="tag t1">เสี่ยง ${d[1]}</span>` : ''}</span></summary>
        <ul>${d.clusters.map((c) => `<li>${tag(c.tier)} <a href="${mapLink(c)}">${esc(c.name)}</a> <span class="muted small">${esc(String(c.members[0].detail || '').slice(0, 70))}</span></li>`).join('')}
        ${d.news ? `<li class="muted small">มีข่าวน้ำท่วมในเขตนี้ ${d.news} ข่าว (ไม่ระบุจุด) – ดูในแท็บข่าวของหน้าแผนที่ละเอียด</li>` : ''}</ul>
      </details>`).join('') : '<p class="muted">ยังไม่มีเขตที่มีรายงานน้ำท่วมหรือพื้นที่เสี่ยง</p>';
  }
  // ---------- จุดน้ำท่วมทั้งหมด: แบ่งตามสภาพถนน รุนแรงก่อน ----------
  const BLOCK_RE = /ผ่านไม่ได้|ไม่สามารถผ่าน|สัญจรไม่ได้|ปิดการจราจร|ปิดถนน/;
  const HIGH_RE = /เข่า|เอว|ต้นขา|หน้าแข้ง/;
  const LOW_RE = /ข้อเท้า|ตาตุ่ม/;
  const GROUPS = [
    { key: 'block', icon: '🚫', title: 'รถผ่านไม่ได้ / ปิดถนน', open: true },
    { key: 'high', icon: '🌊', title: 'น้ำสูง 20 ซม. ขึ้นไป', open: true },
    { key: 'flood', icon: '💧', title: 'น้ำท่วมขัง', open: false },
    { key: 'unknown', icon: '❔', title: 'ไม่ระบุระดับน้ำ', open: false },
  ];
  const STALE_MS = 3 * 36e5, PER_GROUP = 8;
  const spotUi = { q: '', hideOld: false, me: null, more: {} };
  let lastClusters = [];
  function groupOf(c) {
    const text = c.members.map((m) => m.detail || '').join(' ');
    if (BLOCK_RE.test(text) || c.cm >= 40) return 'block';
    if (c.cm >= 20 || HIGH_RE.test(text)) return 'high';
    if (c.cm > 0 || LOW_RE.test(text)) return 'flood';
    return 'unknown';
  }
  const kmTo = (c) => (spotUi.me ? distKm(spotUi.me[0], spotUi.me[1], c.la, c.lo) : null);
  function row(c) {
    const old = c.t && Date.now() - c.t > STALE_MS;
    const km = kmTo(c);
    return `<a class="srow${old ? ' old' : ''}" href="${mapLink(c)}">
      <span class="depth g-${c.group}">${c.cm ? Math.round(c.cm) + '<small>ซม.</small>' : c.group === 'block' ? '🚫' : '–'}</span>
      <span class="sbody"><b>${esc(c.name)}</b>
        <span class="muted small">เขต${esc(c.district || '–')}${c.t ? ' · ' + ago(c.t) : ''}${old ? ' (อาจลดแล้ว)' : ''}${km != null ? ` · ห่าง ${km < 1 ? Math.round(km * 1000) + ' ม.' : km.toFixed(1) + ' กม.'}` : ''}</span>
        <span class="muted small sdetail">${esc(String(c.members[0].detail || '').slice(0, 90))}</span></span>
      <span class="chips">${c.sources.length > 1 ? `<span class="chip">ยืนยัน ${c.sources.length} แหล่ง</span>` : sourceChips(c)}</span>
    </a>`;
  }
  function renderSpots(clusters) {
    if (clusters) lastClusters = clusters;
    const q = spotUi.q.trim().replace(/^(ถนน|ถ\.|เขต)\s*/, '');
    let main = lastClusters.filter((c) => c.tier >= 2);
    main.forEach((c) => { c.group = groupOf(c); });
    const total = main.length;
    if (q) main = main.filter((c) => (c.name + ' ' + (c.district || '') + ' ' + c.members.map((m) => m.detail || '').join(' ')).includes(q));
    if (spotUi.hideOld) main = main.filter((c) => !c.t || Date.now() - c.t <= STALE_MS);
    const sortFn = spotUi.me ? (a, b) => kmTo(a) - kmTo(b) : (a, b) => (b.cm || 0) - (a.cm || 0) || b.tier - a.tier || (b.t || 0) - (a.t || 0);
    $('allCount').textContent = main.length === total ? `${total} จุด` : `แสดง ${main.length} จาก ${total} จุด`;
    $('spots').innerHTML = !total ? '<p class="muted">ยังไม่มีจุดที่มีรายงานน้ำท่วม</p>' : !main.length ? '<p class="muted">ไม่พบจุดที่ตรงกับตัวกรอง</p>'
      : GROUPS.map((g) => {
        const list = main.filter((c) => c.group === g.key).sort(sortFn);
        if (!list.length) return '';
        const n = spotUi.more[g.key] ? list.length : PER_GROUP;
        return `<details class="sgroup g-${g.key}"${g.open || q || spotUi.me ? ' open' : ''}>
          <summary><span class="gicon">${g.icon}</span> ${g.title} <span class="gcount">${list.length}</span></summary>
          <div class="slist">${list.slice(0, n).map(row).join('')}</div>
          ${list.length > n ? `<button type="button" class="btn small smore" data-g="${g.key}">ดูอีก ${list.length - n} จุด ▾</button>` : ''}
        </details>`;
      }).join('');
    $('spots').querySelectorAll('.smore').forEach((b) => b.onclick = () => { spotUi.more[b.dataset.g] = true; renderSpots(); });
    renderRiskSummary(lastClusters.filter((c) => c.tier === 1));
  }
  // พื้นที่เสี่ยง: สรุปสั้น 2 บรรทัด ฝนหนัก (เรียง มม.) และคลองใกล้เต็ม (เรียง %)
  function renderRiskSummary(risk) {
    const ms = risk.flatMap((c) => c.members.map((m) => ({ ...m, c })));
    const pick = (src, val) => {
      const best = new Map();
      for (const m of ms.filter((x) => x.src === src)) { const k = m.name; if (!best.has(k) || val(m) > val(best.get(k))) best.set(k, m); }
      return [...best.values()].sort((a, b) => val(b) - val(a));
    };
    const rain = pick('rain', (m) => m.mm || 0), wl = pick('wl', (m) => m.pct || 0);
    const chip = (m, label) => `<a class="rchip" href="${mapLink(m.c)}">${esc(label)}</a>`;
    const line = (icon, title, arr, fmt) => arr.length ? `<div class="rline"><span class="rhead">${icon} ${title} <b>${arr.length}</b></span>${arr.slice(0, 10).map(fmt).join('')}${arr.length > 10 ? `<span class="muted small">และอีก ${arr.length - 10}</span>` : ''}</div>` : '';
    $('riskCount').textContent = risk.length;
    $('riskSpots').innerHTML = (line('🌧', 'ฝนหนัก (24 ชม.)', rain, (m) => chip(m, `${m.district ? 'เขต' + m.district : m.name.replace(/^สถานีฝน\s*/, '')} ${Math.round(m.mm)} มม.`))
      + line('🌊', 'คลอง/แม่น้ำใกล้เต็มตลิ่ง', wl, (m) => chip(m, `${m.name} ${Math.round(m.pct)}%`))) || '<p class="muted">ไม่มีพื้นที่เสี่ยงในขณะนี้</p>';
  }
  // ตัวกรอง
  $('spotQ').oninput = (e) => { spotUi.q = e.target.value; renderSpots(); };
  $('spotOld').onchange = (e) => { spotUi.hideOld = e.target.checked; renderSpots(); };
  $('spotNear').onclick = () => {
    const btn = $('spotNear');
    if (spotUi.me) { spotUi.me = null; btn.classList.remove('on'); btn.textContent = '📍 ใกล้ฉัน'; renderSpots(); return; }
    if (!navigator.geolocation) { alert('เบราว์เซอร์นี้ไม่รองรับการหาตำแหน่ง'); return; }
    btn.textContent = 'กำลังหาตำแหน่ง…';
    navigator.geolocation.getCurrentPosition((p) => {
      spotUi.me = [p.coords.latitude, p.coords.longitude]; btn.classList.add('on'); btn.textContent = '📍 ใกล้ฉัน ✓'; renderSpots();
    }, () => { btn.textContent = '📍 ใกล้ฉัน'; alert('หาตำแหน่งไม่ได้ กรุณาอนุญาตการเข้าถึงตำแหน่ง'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  };
  async function renderTmd() {
    try {
      const d = await F.fetchTmd();
      const x = d.items[0];
      $('tmdLine').innerHTML = x ? `<p class="tmdline">⚠ <b>กรมอุตุฯ:</b> ${esc(x.title)} <span class="muted small">(${esc(x.announced)})</span></p>` : '';
    } catch (e) { $('tmdLine').innerHTML = ''; }
  }

  // ---------- แนวโน้มน้ำ (ThaiWater) ----------
  const fmt = (v, d = 0) => (v == null || isNaN(v) ? '–' : Number(v).toLocaleString('th-TH', { maximumFractionDigits: d }));
  const lvDot = (lv) => `<span class="dot" style="--c:${F.LEVEL[lv].color}"></span>`;
  async function renderOutlookTw() {
    let d = null;
    try { d = await F.fetchTw(); } catch (e) { /* ยังไม่มีไฟล์ */ }
    if (!d) { $('olRain').textContent = 'ยังไม่มีข้อมูลพยากรณ์'; renderNorth([]); $('twLine').innerHTML = ''; return; }
    const bkk = F.twBkkHeavy(d);
    const near = (d.heavy || []).filter((p) => ['11', '12', '13', '73', '74'].includes(p.code)).map((p) => p.name);
    $('twLine').innerHTML = bkk ? `<p class="tmdline">🌧 <b>ThaiWater:</b> คาดว่ากรุงเทพฯ มีฝนตกหนัก (ระดับ ${esc(bkk.level)})</p>` : '';
    const imgs = (d.images || []).filter((i) => i.group === 'ประเทศไทย').map((i) => ({ ...i, file: /^data\//.test(i.file) ? i.file : 'data/' + i.file }));
    $('olRain').classList.remove('muted', 'small');
    $('olRain').innerHTML = `<p class="ol-main">${bkk ? `<b class="tag t3">ฝนหนัก</b> กรุงเทพฯ อยู่ในรายชื่อจังหวัดที่คาดว่าฝนตกหนัก` : 'ไม่มีการพยากรณ์ฝนหนักใน กทม.'}</p>
      ${near.length ? `<p class="small muted">จังหวัดรอบ ๆ ที่คาดว่าฝนหนัก: ${esc(near.join(', '))}</p>` : ''}
      ${imgs.length ? `<div class="ol-imgs">${imgs.map((i) => `<a href="${esc(i.file)}" target="_blank" rel="noopener"><img src="${esc(i.file)}?v=${encodeURIComponent(i.datetime || '')}" alt="ภาพพยากรณ์ฝนวันที่ ${i.day}" loading="lazy"><span>วันที่ ${i.day}</span></a>`).join('')}</div>` : ''}`;
    renderNorth(d.dams || []);
  }
  let upstream = null, dams = null;
  function renderOutlookWl(up) { upstream = up || []; renderRiver(); renderNorth(); }
  function renderRiver() {
    const rows = (upstream || []).filter((c) => ['CPY014', 'C.12', 'CPY015'].includes(c.code));
    $('olRiver').classList.remove('muted', 'small');
    $('olRiver').innerHTML = rows.length ? rows.map((c) => {
      if (c.missing || c.pct == null) return `<div class="ol-row">${lvDot(0)}<span>${esc(c.label)}</span><b>–</b></div>`;
      const d = c.msl != null && c.prev != null ? c.msl - c.prev : 0;
      const tr = Math.abs(d) < 0.005 ? 'ทรงตัว' : d > 0 ? '▲ ขึ้น' : '▼ ลง';
      return `<div class="ol-row">${lvDot(F.wlLevel(c.pct))}<span>${esc(c.label)}<small>${tr}${c.stale ? ' · ค่าเก่า' : ''}</small></span><b>${fmt(c.pct)}%</b></div>`;
    }).join('') + '<p class="small muted">% ของความสูงตลิ่ง</p>' : '<p class="muted small">ไม่มีข้อมูลระดับน้ำ</p>';
  }
  function renderNorth(d) {
    if (d) dams = d;
    const c13 = (upstream || []).find((c) => c.code === 'C.13');
    const main = (dams || []).filter((m) => ['ภูมิพล', 'สิริกิติ์', 'แควน้อยบำรุงแดน', 'ป่าสักชลสิทธิ์'].includes(m.name));
    if (!c13 && !main.length) { if (upstream && dams) $('olNorth').innerHTML = '<p class="muted small">ไม่มีข้อมูล</p>'; return; }
    const rel = main.reduce((a, m) => a + (+m.released || 0), 0);
    $('olNorth').classList.remove('muted', 'small');
    $('olNorth').innerHTML = (c13 && c13.q != null ? `<div class="ol-row">${lvDot(c13.q >= 2500 ? 3 : c13.q >= 1500 ? 2 : c13.q >= 800 ? 1 : 0)}<span>เขื่อนเจ้าพระยา ชัยนาท<small>น้ำที่ปล่อยลงมา ถึง กทม. ใน 1–3 วัน</small></span><b>${fmt(c13.q)}<small> ลบ.ม./วิ</small></b></div>` : '')
      + main.map((m) => `<div class="ol-row">${lvDot(m.pct >= 100 ? 3 : m.pct >= 90 ? 2 : m.pct >= 80 ? 1 : 0)}<span>เขื่อน${esc(m.name)}<small>ปล่อย ${fmt(m.released, 2)} ล้าน ลบ.ม./วัน</small></span><b>${fmt(m.pct)}%</b></div>`).join('')
      + (main.length ? `<p class="small muted">% = น้ำในอ่างเทียบความจุ · 4 เขื่อนหลักปล่อยรวม ${fmt(rel, 1)} ล้าน ลบ.ม./วัน</p>` : '');
  }

  // ---------- โหลดทั้งหมด ----------
  const FEEDS = [['sensor', 'เซ็นเซอร์ กทม.', 'fetchSensors'], ['event', 'หน่วยงาน/iTIC', 'fetchEvents'], ['traffy', 'Traffy', 'fetchTraffy'],
    ['rain', 'ฝน ThaiWater', 'fetchRain'], ['wl', 'ระดับน้ำ ThaiWater', 'fetchWl'], ['news', 'ข่าว', 'fetchNews'], ['web', 'ประชาชนปักหมุด', 'fetchWebReports']];
  let last = 0, gen = 0;
  // แสดงผลทันทีที่แต่ละแหล่งโหลดเสร็จ ไม่ต้องรอแหล่งที่ช้าที่สุด (บางแหล่งใช้เวลานานถึง 1–2 นาที)
  async function refresh() {
    const my = ++gen;
    last = Date.now();
    $('updated').textContent = 'กำลังอัปเดต…';
    renderTmd();
    renderOutlookTw();
    loadRadar();
    if (!lyr.cam.getLayers().length) loadCams();
    const geo = await F.loadDistricts().catch(() => null);
    drawDistricts(geo, []);
    const D = {};
    const feeds = FEEDS.map(([key, name]) => ({ key, name, ok: false, pending: true }));
    let timer = null;
    const render = (final) => {
      if (my !== gen) return; // มีรอบใหม่เริ่มแล้ว
      try {
        const clusters = cluster(signals(D), geo);
        const dists = byDistrict(clusters, D.news);
        renderHeadline(clusters, dists, feeds);
        drawSpots(clusters);
        renderTop(clusters);
        renderDistricts(dists);
        renderSpots(clusters);
        fitToSpots(clusters);
        const waiting = feeds.filter((f) => f.pending).map((f) => f.name);
        $('asof').textContent = `ข้อมูล ณ ${fmtDT(new Date(last))}`;
        $('updated').textContent = waiting.length ? `กำลังโหลด: ${waiting.join(', ')}…` : `อัปเดต ${fmtTime(new Date(last))} · รีเฟรชอัตโนมัติทุก 15 นาที`;
        if (final) drawRoads(clusters, my);
      } catch (e) {
        console.error(e);
        $('headline').textContent = 'แสดงผลไม่สำเร็จ: ' + e.message;
      }
    };
    await Promise.all(FEEDS.map(([k, , fn], i) => F[fn]()
      .then((r) => { D[k] = r.items; feeds[i].ok = true; if (k === 'wl') renderOutlookWl(r.upstream); })
      // ระบบปักหมุดที่ยังไม่เปิดใช้ ไม่นับเป็นแหล่งที่ล้มเหลว
      .catch((e) => { D[k] = null; feeds[i].off = /ยังไม่ได้เปิด/.test(e.message); })
      .finally(() => { feeds[i].pending = false; clearTimeout(timer); timer = setTimeout(() => render(false), 150); })));
    clearTimeout(timer);
    render(true);
  }
  // ซูมให้เห็นจุดน้ำท่วมทั้งหมด (ถนนสีแดงจะเห็นชัดขึ้น) เว้นแต่ผู้ใช้เลื่อนแผนที่เองแล้ว
  let userMoved = false;
  map.on('dragstart zoomstart', (e) => { if (!fitting) userMoved = true; });
  let fitting = false;
  function fitToSpots(clusters) {
    if (userMoved) return;
    // รวมพื้นที่เสี่ยงด้วยเมื่อแสดงอยู่ เพื่อให้เห็นตั้งแต่เปิดหน้า
    const showRisk = map.hasLayer(lyr.risk);
    const pts = clusters.filter((c) => c.tier >= 2 || (showRisk && c.tier === 1)).map((c) => [c.la, c.lo]);
    if (!pts.length) return;
    fitting = true;
    if (pts.length === 1) map.setView(pts[0], 15); else map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
    setTimeout(() => { fitting = false; }, 500);
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > F.REFRESH_MS) refresh(); });
  setInterval(refresh, F.REFRESH_MS);
  refresh();
})();
