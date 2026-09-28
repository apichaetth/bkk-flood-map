/* แผนที่สถานการณ์น้ำท่วม กทม.
 * - ข้อมูลเรียลไทม์ (เซ็นเซอร์ กทม., ThaiWater, iTIC/Longdo, Traffy, กล้อง) ดึงจากเบราว์เซอร์ของผู้ชมโดยตรง
 *   เพราะบางแหล่ง (เช่น floodbangkok.bangkok.go.th) เปิดให้เฉพาะ IP ในประเทศไทย
 * - ข่าว + สรุป AI + ประกาศกรมอุตุฯ อ่านจาก data/*.json ที่ GitHub Actions สร้างทุก 15 นาที
 */
(function () {
  'use strict';

  const {
    REFRESH_MS, RAIN_HEAVY_MM, URL, $, esc, th, fmtTime, fmtDT, ago, distKm, getJSON, cssVar, num, inBkk,
    LEVEL, badge, wlLevel, rainStep, SEV_LV,
  } = Flood;
  const CAM_NEAR_KM = 1.5;

  // ---------- แผนที่ ----------
  const isMobile = matchMedia('(max-width: 860px)').matches;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  // จอสัมผัส: จุดเล็ก ๆ กดยาก — วาดด้วย canvas ที่มีระยะกดรอบจุด (tolerance) และหมุด HTML มีพื้นที่กดอย่างน้อย 34 px
  const touch = matchMedia('(pointer: coarse)').matches;
  const map = L.map('map', { zoomControl: !isMobile, minZoom: 9, maxZoom: 18, preferCanvas: true, renderer: L.canvas({ padding: 0.3, tolerance: touch ? 14 : 6 }) }).setView(isMobile ? [13.66, 100.58] : [13.76, 100.55], isMobile ? 10 : 11);
  // แผนที่ฐาน OpenStreetMap (ฟรี ไม่ต้องใช้ key) โหมดมืดใช้ CSS filter ใน style.css
  // ซูมไกล (เห็นทั้งเมือง): ซ่อนป้ายลูกศรแนวโน้มทีละจุด เหลือแค่ ⬆⬆/⬇⬇ ไม่ให้บังหมุด
  const zcls = () => map.getContainer().classList.toggle('zlow', map.getZoom() < 13);
  map.on('zoomend', zcls); map.whenReady(zcls);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  Flood.addLocate(map);
  // เปิดจากหน้าสรุปด้วย map.html?lat=..&lng=..&z=.. ให้ซูมไปที่จุดนั้นและวงไว้
  (function focusFromUrl() {
    const q = new URLSearchParams(location.search);
    const la = num(q.get('lat')), lo = num(q.get('lng'));
    if (la == null || lo == null || !inBkk(la, lo)) return;
    map.setView([la, lo], Math.min(18, Math.max(12, num(q.get('z')) || 16)));
    L.circle([la, lo], { radius: 250, color: cssVar('--critical'), weight: 2, dashArray: '6 5', fill: false, interactive: false }).addTo(map);
  })();

  const LEVEL_VAR = { 0: '--good', 1: '--warning', 2: '--serious', 3: '--critical' };
  const layers = {
    districts: L.layerGroup().addTo(map),
    radar: L.layerGroup().addTo(map),
    rain: L.layerGroup().addTo(map),
    wl: L.layerGroup().addTo(map),
    canal: L.layerGroup().addTo(map),
    bmaRain: L.layerGroup(),
    news: L.layerGroup().addTo(map),
    traffy: L.layerGroup().addTo(map),
    event: L.layerGroup().addTo(map),
    sensor: L.layerGroup().addTo(map),
    cam: L.layerGroup().addTo(map),
    web: L.layerGroup().addTo(map),
    elev: L.layerGroup(), // ความสูงพื้นดิน DeltaDTM (ปิดไว้ก่อน เปิดจากปุ่มชั้นแผนที่)
  };
  // เปิดครั้งแรกแสดงเฉพาะน้ำท่วม (เซ็นเซอร์ หน่วยงาน Traffy หมุดประชาชน) ชั้นอื่นเปิดเองจากปุ่มชั้นแผนที่ แล้วจำค่าที่เลือกไว้ในเครื่อง
  const LYR_KEY = 'bkkflood.layers', LYR_ON = ['sensor', 'event', 'traffy', 'web', 'districts'];
  {
    const saved = Flood.store.get(LYR_KEY) || {};
    for (const [k, l] of Object.entries(layers)) {
      const want = k in saved ? saved[k] : LYR_ON.includes(k);
      if (want && !map.hasLayer(l)) map.addLayer(l); else if (!want && map.hasLayer(l)) map.removeLayer(l);
    }
    const save = (e, on) => { const k = Object.keys(layers).find((x) => layers[x] === e.layer); if (!k) return; const v = Flood.store.get(LYR_KEY) || {}; v[k] = on; Flood.store.set(LYR_KEY, v); };
    map.on('overlayadd', (e) => save(e, true)); map.on('overlayremove', (e) => save(e, false));
  }
  L.control.layers(null, {
    'เซ็นเซอร์น้ำท่วมถนน กทม.': layers.sensor,
    'รายงานน้ำท่วม (หน่วยงาน/iTIC)': layers.event,
    'ประชาชนแจ้งผ่านเว็บนี้': layers.web,
    'ประชาชนแจ้ง (Traffy 24 ชม.)': layers.traffy,
    'ตำแหน่งจากข่าว / YouTube': layers.news,
    'ระดับน้ำคลอง/แม่น้ำ (ThaiWater)': layers.wl,
    'ระดับน้ำคลอง กทม. (312 สถานี)': layers.canal,
    'ปริมาณฝน 24 ชม. (ThaiWater)': layers.rain,
    'ฝน – สถานี กทม.': layers.bmaRain,
    'เรดาร์ฝน (RainViewer)': layers.radar,
    'กล้อง CCTV สาธารณะ': layers.cam,
    'ขอบเขตเขต': layers.districts,
    'ความสูงพื้นดิน (กดดูค่า)': layers.elev,
  }, { collapsed: true, position: 'topright' }).addTo(map);

  // พื้นที่กดอย่างน้อย 22 px รอบจุด (จุดเล็กก็ยังกดง่ายบนมือถือ) โดยขนาดที่มองเห็นเท่าเดิม
  // tr: ป้ายลูกศรแนวโน้มมุมขวาบนของหมุด (⬆⬆ เพิ่มมาก … ⬇⬇ ลดมาก)
  const icon = (cls, color, text = '', size = 18, extra = '', tr = '') => {
    size = Math.max(5, Math.round(size * Flood.MS));
    if (size < 14) text = ''; // เล็กเกินอ่านตัวเลข ดูได้ในป๊อปอัป
    const hit = Math.max(size, touch ? 34 : 24);
    return L.divIcon({
      className: '', iconSize: [hit, hit], iconAnchor: [hit / 2, hit / 2], popupAnchor: [0, -size / 2],
      html: `<div class="mkhit" style="width:${hit}px;height:${hit}px"><div class="mk ${cls} ${extra}" style="--c:${color};width:${size}px;height:${size}px">${text}</div>${tr ? `<span class="mk-tr${tr.length > 1 ? ' two' : ''}">${tr}</span>` : ''}</div>`,
    });
  };

  // ---------- สถานะแหล่งข้อมูล ----------
  const FEEDS = {
    sensor: { name: 'เซ็นเซอร์น้ำท่วมถนน – สำนักการระบายน้ำ กทม.', link: 'https://weather.bangkok.go.th/flood/', note: 'เปิดได้เฉพาะเครือข่ายในประเทศไทย' },
    event: { name: 'รายงานน้ำท่วมถนน – iTIC / Longdo Traffic (กทม., ทล., ผู้ใช้)', link: 'https://traffic.longdo.com' },
    traffy: { name: 'เรื่องแจ้งจากประชาชน – Traffy Fondue', link: 'https://fondue.traffy.in.th/teamchadchart' },
    web: { name: 'ประชาชนแจ้งผ่านเว็บนี้ (ปักหมุด)', link: 'log.html' },
    wl: { name: 'ระดับน้ำ – ThaiWater (สสน.)', link: 'https://www.thaiwater.net' },
    rain: { name: 'ปริมาณฝน – ThaiWater (สสน.)', link: 'https://www.thaiwater.net' },
    relay: { name: 'ระดับน้ำคลอง / ฝน / อุโมงค์ – สำนักการระบายน้ำ กทม.', link: 'https://weather.bangkok.go.th/water' },
    news: { name: 'ข่าว – Google News RSS + สรุปโดย Gemini', link: 'https://news.google.com' },
    youtube: { name: 'คลิป – YouTube Data API + สรุปโดย Gemini', link: 'https://www.youtube.com/results?search_query=%E0%B8%99%E0%B9%89%E0%B8%B3%E0%B8%97%E0%B9%88%E0%B8%A7%E0%B8%A1+%E0%B8%81%E0%B8%A3%E0%B8%B8%E0%B8%87%E0%B9%80%E0%B8%97%E0%B8%9E' },
    tmd: { name: 'ประกาศเตือนภัย – กรมอุตุนิยมวิทยา', link: 'https://www.tmd.go.th' },
    cam: { name: 'กล้อง CCTV สาธารณะ – iTIC / Longdo', link: 'https://traffic.longdo.com/cameralist' },
    radar: { name: 'เรดาร์ฝน – RainViewer', link: 'https://www.rainviewer.com' },
  };
  function setFeed(k, status, msg, dataTime) {
    Object.assign(FEEDS[k], { status, msg, dataTime });
    $('feeds').innerHTML = Object.values(FEEDS).map((f) => {
      const st = f.status || 'loading';
      const s = st === 'ok' ? 'ใช้งานได้' + (f.msg ? ' · ' + esc(f.msg) : '') + (f.dataTime ? ' · ข้อมูลล่าสุด ' + fmtDT(f.dataTime) : '')
        : st === 'loading' ? 'กำลังโหลด…' : st === 'off' ? 'ยังไม่เปิดใช้ – ' + esc(f.msg || '') : 'ใช้งานไม่ได้ขณะนี้ – ' + esc(f.msg || '');
      return `<div class="feed ${st}"><span class="st"></span><div><a href="${f.link}" target="_blank" rel="noopener">${esc(f.name)}</a><div class="fs">${s}${f.note ? ' · ' + esc(f.note) : ''}</div></div></div>`;
    }).join('');
    const failed = Object.entries(FEEDS).filter(([k, f]) => f.status === 'fail' && k !== 'radar' && k !== 'cam' && k !== 'sensor' && !(k === 'web' && /ยังไม่ได้เปิด/.test(f.msg || ''))).map(([, f]) => f);
    // เซ็นเซอร์ กทม. ล่มบ่อยช่วงฝนหนัก (ปัญหาที่เซิร์ฟเวอร์ต้นทาง) แจ้งแยกแบบไม่ตกใจ
    const bmaDown = FEEDS.sensor.status === 'fail';
    const lines = [];
    if (failed.length) lines.push(`ดึงข้อมูลไม่สำเร็จ ${failed.length} แหล่ง (${failed.map((f) => f.name.split(' – ')[0]).join(', ')}) ตัวเลขอาจไม่ครบ – ดูแท็บ "แหล่งข้อมูล"`);
    if (bmaDown) lines.push('ระบบเซ็นเซอร์ของ กทม. ไม่ตอบสนองขณะนี้ (ปัญหาที่ต้นทาง) ใช้ข้อมูลแหล่งอื่นแทน');
    $('warn').hidden = !lines.length;
    $('warn').classList.toggle('soft', !failed.length);
    $('warn').textContent = lines.join(' · ');
  }

  const S = {};

  // ---------- 1) เซ็นเซอร์น้ำท่วมถนน กทม. ----------
  async function loadSensors() {
    setFeed('sensor', 'loading');
    try {
      const r = await Flood.fetchSensors();
      S.sensor = r.items;
      setFeed('sensor', 'ok', r.msg, r.newest);
    } catch (e) { S.sensor = null; setFeed('sensor', 'fail', Flood.errMsg('sensor', e)); }
    drawSensors();
  }
  // แนวโน้มน้ำจาก data/trends.json (เซ็นเซอร์ถนน/คลอง) ใช้ในป๊อปอัปและลูกศรบนหมุด
  const TRL = { fast: ['⬆⬆', 'เพิ่มขึ้นมาก'], up: ['⬆', 'เพิ่มขึ้น'], peak: ['⏸', 'ใกล้จุดสูงสุด'], flat: ['➖', 'ทรงตัว'], down: ['⬇', 'ลดลง'], dfast: ['⬇⬇', 'ลดลงมาก'] };
  async function loadTrends() {
    const d = await Flood.getJSON('data/trends.json', 20000, { cache: 'no-cache' }).catch(() => null);
    S.trend = d && Date.now() - new Date(d.updated) < 90 * 6e4 ? { road: new Map(d.road.map((x) => [x.c, x])), canal: new Map(d.canal.map((x) => [x.c, x])),
      rain: new Map((d.rain || []).map((x) => [x.c, x])), rainList: d.rain || [] } : null;
    if (S.trend && S.sensor) {
      // ค่าจาก ThaiWater/เครื่องในไทยใหม่กว่าค่าจากระบบแจ้งเตือน: ใช้ค่าที่ใหม่กว่า
      for (const x of S.sensor) {
        const tr = S.trend.road.get(x.s.code);
        if (tr && tr.t > (x.t ? +x.t : 0)) { x.cm = tr.v; x.t = new Date(tr.t); x.stale = false; x.lv = Flood.sensorLevel(tr.v); }
      }
    }
    drawSensors(); drawRelay(); if (S.rain) drawRain(); listTrends(d);
  }
  // รายการแนวโน้มในแผง: กดแล้วไปที่หมุด
  function listTrends(d) {
    const sec = $('secTrend');
    if (!sec) return;
    sec.hidden = !S.trend;
    if (!S.trend) return;
    const mk = (x, kind) => {
      const src = kind === 'road' ? (S.sensor || []).find((y) => y.s.code === x.c) : ((S.relay && S.relay.canal) || []).find((y) => y.c === x.c);
      return { ...x, kind, la: x.la ?? (src && src.la), lo: x.lo ?? (src && src.lo), get marker() { return src && src.marker; } };
    };
    const all = [...d.road.map((x) => mk(x, 'road')), ...d.canal.map((x) => mk(x, 'canal'))].filter((x) => x.la && x.lo && x.tr !== 'flat');
    const ORD = { fast: 0, up: 1, peak: 2, down: 3, dfast: 4 };
    all.sort((a, b) => ORD[a.tr] - ORD[b.tr] || (b.eta != null) - (a.eta != null) || (b.kind === 'road') - (a.kind === 'road') || Math.abs(b.d30) - Math.abs(a.d30));
    const n = (k) => all.filter((x) => k.includes(x.tr)).length;
    $('trendSum').textContent = all.length ? `⬆⬆ ${n(['fast'])} · ⬆ ${n(['up'])} · ⏸ ${n(['peak'])} · ⬇ ${n(['down'])} · ⬇⬇ ${n(['dfast'])} จุด (เทียบ 30 นาทีก่อน)` : '';
    const lvOf = (x) => (x.kind === 'road' ? Flood.sensorLevel(x.v) : x.st >= 2 ? 3 : x.st === 1 ? 2 : 0);
    listInto('listTrend', all.slice(0, 12), (x) => {
      const road = x.kind === 'road', dp = road ? 0 : 2, unit = road ? ' ซม.' : ' ม.';
      return { dot: LEVEL[lvOf(x)].color, title: `${TRL[x.tr][0]} ${x.n}`, go: x,
        sub: `${road ? 'ถนน' : 'คลอง'} · เขต${x.d || '–'} · ${TRL[x.tr][1]}${x.eta != null ? ` · ถึงวิกฤตใน ~${x.eta} ชม.` : ''}`,
        right: `${(+x.v).toFixed(dp)}${unit} (${x.d30 > 0 ? '+' : ''}${(+x.d30).toFixed(dp)})` };
    }, 'น้ำทรงตัวทุกจุด ไม่มีจุดที่กำลังเพิ่มหรือลด');
  }
  const rainTrHtml = (x) => (x && x.tr !== 'flat' ? `<div class="m" style="margin-top:4px"><b>🌧${TRL[x.tr][0]} ฝน${{ fast: 'แรงขึ้นมาก', up: 'แรงขึ้น', down: 'เบาลง', dfast: 'เบาลงมาก' }[x.tr]}</b> (${x.d60 > 0 ? '+' : ''}${x.d60} มม. เทียบชั่วโมงก่อน)</div>` : '');
  const trendHtml = (tr, unit, dp) => {
    if (!tr) return '';
    const hh = (t) => new Intl.DateTimeFormat('th-TH', { timeZone: Flood.TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    return `<div class="m" style="margin-top:4px"><b>${TRL[tr.tr][0]} ${TRL[tr.tr][1]}</b> (${tr.d30 > 0 ? '+' : ''}${tr.d30.toFixed(dp)}${unit} ใน 30 นาที)${tr.eta != null ? ` · ถึงวิกฤตใน ~${tr.eta} ชม.` : ''}<br>`
      + (tr.s || []).slice(-6).map(([t, v]) => `${hh(t)} ${(+v).toFixed(dp)}`).join(' → ') + unit + '</div>';
  };
  function drawSensors() {
    layers.sensor.clearLayers();
    if (!S.sensor) { $('kSensor').textContent = '–'; return; }
    for (const x of S.sensor) {
      const tr = S.trend && S.trend.road.get(x.s.code);
      const flooded = x.lv > 0;
      const arrow = tr && TRL[tr.tr] && tr.tr !== 'flat' ? TRL[tr.tr][0] : '';
      // สีหมุด = สถานการณ์ตอนนี้ · ป้ายลูกศร = แนวโน้ม (หมุดที่ไม่ท่วมแต่น้ำกำลังเปลี่ยนก็แสดง)
      const size = flooded ? 18 : arrow ? 11 : 8;
      const html = `<div class="pp"><div class="m">เซ็นเซอร์น้ำท่วมถนน กทม. · ${esc(x.s.code)}</div>
        <h3>${esc(x.s.name || x.s.road || '')}</h3>
        ${x.stale ? '<span class="badge" style="--c:var(--stale)">ไม่มีค่าล่าสุด</span>' : badge(x.lv)}
        <div style="margin-top:4px"><span class="big">${x.cm != null && !x.stale ? x.cm : '–'}</span> ซม.</div>
        <div class="m">${esc(x.s.road || '')} ${x.s.district ? '· ' + esc(x.s.district) : ''}<br>
        อ่านค่า ${x.t ? fmtDT(x.t) + ' (' + ago(x.t) + ')' : '–'}</div>${trendHtml(tr, ' ซม.', 0)}</div>`;
      x.marker = L.marker([x.la, x.lo], {
        icon: icon('sensor', LEVEL[x.lv].color, flooded ? Math.round(x.cm) : '', size, (LEVEL[x.lv].dark ? 'dark' : '') + (x.stale ? ' stale' : ''), x.stale ? '' : arrow),
        zIndexOffset: flooded ? 1000 + x.cm : arrow ? 500 : 0, opacity: flooded || arrow ? 1 : 0.75,
      }).bindPopup(html).addTo(layers.sensor);
    }
    $('kSensor').textContent = S.sensor.filter((x) => x.lv > 0).length;
    renderFloodList();
  }

  // ---------- 2) รายงานน้ำท่วมจากหน่วยงาน / iTIC ----------
  async function loadEvents() {
    setFeed('event', 'loading');
    try {
      const r = await Flood.fetchEvents();
      S.event = r.items;
      setFeed('event', 'ok', r.msg, r.newest);
    } catch (e) { S.event = null; setFeed('event', 'fail', Flood.errMsg('event', e)); }
    drawEvents();
  }
  function drawEvents() {
    layers.event.clearLayers();
    if (!S.event) { $('kEvent').textContent = '–'; return; }
    for (const x of S.event) {
      const e = x.e;
      const html = `<div class="pp">${badge(x.lv)} <span class="m">รายงานจาก ${esc(e.contributor || 'iTIC / Longdo')}</span>
        <h3>${esc(e.title)}</h3><div>${esc(String(e.description || '').slice(0, 500))}</div>
        <div class="m" style="margin-top:6px">${esc(x.why)}<br>เริ่ม ${fmtDT(x.start)}${x.stop ? ' · ถึง ' + fmtDT(x.stop) : ''}</div></div>`;
      x.marker = L.marker([x.la, x.lo], { icon: icon('event', LEVEL[x.lv].color, '', 9, LEVEL[x.lv].dark ? 'dark' : ''), zIndexOffset: 800 }).bindPopup(html, { maxWidth: 320 }).addTo(layers.event);
    }
    $('kEvent').textContent = S.event.length;
    renderFloodList(); renderCams();
  }

  // ---------- 3) Traffy Fondue ----------
  async function loadTraffy() {
    setFeed('traffy', 'loading');
    try {
      const r = await Flood.fetchTraffy();
      S.traffy = r.items;
      setFeed('traffy', 'ok', r.msg, r.newest);
    } catch (e) { S.traffy = null; setFeed('traffy', 'fail', Flood.errMsg('traffy', e)); }
    drawTraffy();
  }
  function drawTraffy() {
    layers.traffy.clearLayers();
    if (!S.traffy) { $('kTraffy').textContent = '–'; return; }
    const col = [0, 1, 2, 3].map((l) => cssVar(LEVEL_VAR[l]));
    // วาดบน canvas: จุด Traffy มีได้หลายพันจุด แบบ HTML ทีละจุดทำให้แผนที่ช้ามากบนมือถือ
    for (const x of S.traffy) {
      const r = x.r;
      const html = () => `<div class="pp">${badge(x.lv)} <span class="m">ประชาชนแจ้ง · ยังไม่ยืนยัน</span>
        <div style="margin-top:6px">${esc((r.description || '').slice(0, 320))}</div>
        ${r.photo_url ? `<img loading="lazy" src="${esc(r.photo_url)}" alt="ภาพจากผู้แจ้ง" referrerpolicy="no-referrer">` : ''}
        <div class="m" style="margin-top:6px">${esc(r.address || '')}<br>แจ้งเมื่อ ${fmtDT(x.t)} (${ago(x.t)}) · สถานะ: ${esc(r.state || '')}<br>
        <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.ticket_id)}" target="_blank" rel="noopener">ดูเรื่อง ${esc(r.ticket_id)}</a></div></div>`;
      x.marker = L.circleMarker([x.la, x.lo], { keepSize: true, radius: isMobile ? 4 : 5, color: col[x.lv], weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindPopup(html, { maxWidth: 300 }).addTo(layers.traffy);
    }
    $('kTraffy').textContent = S.traffy.length;
    renderFloodList(); renderCams();
  }

  // ---------- 4) ThaiWater ฝน ----------
  async function loadRain() {
    setFeed('rain', 'loading');
    try {
      const r = await Flood.fetchRain();
      S.rain = r.items; S.rainEdge = (r.edge || []).map((x) => ({ ...x, edge: true })); S.basin = r.basin;
      setFeed('rain', 'ok', r.msg, r.newest);
    } catch (e) { S.rain = null; setFeed('rain', 'fail', Flood.errMsg('rain', e)); }
    drawRain();
  }
  function drawRain() {
    layers.rain.clearLayers();
    if (!S.rain) { $('kRain').textContent = '–'; $('listRain').innerHTML = $('listRain1').innerHTML = '<div class="muted small">ไม่มีข้อมูลฝน</div>'; return; }
    const all = [...S.rain, ...(S.rainEdge || [])];
    for (const s of all) {
      const st = rainStep(s.mm);
      const html = `<div class="pp"><div class="m">สถานีวัดฝน · ${esc(th(s.x.agency && s.x.agency.agency_shortname))}</div><h3>${esc(th(s.x.station.tele_station_name))}</h3>
        ${s.mm > RAIN_HEAVY_MM ? badge(3, 'ฝน' + st[2]) : ''}
        <div><span class="big">${s.mm}</span> มม. / 24 ชม. (${st[2]})${s.mm1 != null ? ` · ${s.mm1} มม. ชั่วโมงล่าสุด` : ''}</div>
        ${s.mm1 >= 10 ? badge(3, 'ตอนนี้ฝน' + rain1(s.mm1)[1]) : ''}
        ${rainTrHtml(S.trend && S.trend.rain.get('tw:' + s.x.station.id))}
        <div class="m">${esc(loc(s))} · ${fmtDT(s.t)} (${ago(s.t)})</div></div>`;
      // ฝนตกหนักในชั่วโมงล่าสุด: วงแดงรอบจุด ให้เห็นว่าตอนนี้ฝนกำลังหนัก
      if (s.mm1 >= 10) L.circleMarker([s.la, s.lo], { radius: 9 + Math.min(8, s.mm1 / 5), color: cssVar('--critical'), weight: 2.5, fill: false, dashArray: '4 3', interactive: false }).addTo(layers.rain);
      // ฝนหนัก (> 35 มม./24 ชม.) ขอบสีแดง ให้เห็นชัดบนแผนที่
      const heavy = s.mm > RAIN_HEAVY_MM;
      // ฝนน้อย/ไม่มีฝน: จุดเล็กและจาง ไม่ให้แย่งสายตาจากจุดที่สำคัญ
      // ฝนหนัก = จุดเสี่ยงน้ำท่วม ใช้สีแดงทั้งจุด (แดงหมายถึงเสี่ยงน้ำท่วมทั้งแผนที่) ฝนหนักมาก (> 90 มม.) ใหญ่ขึ้นอีก
      // ขนาดวงแปรตามปริมาณฝน (รากที่สอง เพื่อให้พื้นที่วงสัมพันธ์กับปริมาณ) เห็นแนวโน้มได้ทันที
      const radius = Math.min(11, 2 + Math.sqrt(Math.max(0, s.mm)) * 0.7);
      const style = heavy ? { radius, color: '#fff', weight: 1.5, fillOpacity: 1, opacity: 1 }
        : s.mm > 10 ? { radius, color: '#fff', weight: 1.2, fillOpacity: 0.85, opacity: 1 }
        : s.mm > 0 ? { radius, color: '#fff', weight: 0.8, fillOpacity: 0.5, opacity: 0.6 }
        : { radius: 2, color: '#fff', weight: 0.5, fillOpacity: 0.3, opacity: 0.4 };
      s.marker = L.circleMarker([s.la, s.lo], { ...style, fillColor: heavy ? heavyRed(s.mm) : cssVar(st[1].slice(4, -1)) })
        .bindPopup(html).addTo(layers.rain);
      if (heavy) s.marker.bringToFront();
    }
    // ป้ายลูกศรฝนแรงขึ้น/เบาลง (ทุกสถานีทั้ง ThaiWater และ กทม.) เทียบฝน 1 ชม. กับชั่วโมงก่อน
    for (const x of (S.trend && S.trend.rainList) || []) {
      if (x.tr === 'flat') continue;
      L.marker([x.la, x.lo], { icon: L.divIcon({ className: '', iconSize: [30, 16], iconAnchor: [-2, 18], html: `<span class="rtr ${x.tr}">🌧${TRL[x.tr][0]}</span>` }),
        zIndexOffset: 300, interactive: false, keyboard: false }).addTo(layers.rain);
    }
    const top = [...S.rain].sort((a, b) => b.mm - a.mm);
    $('kRain').textContent = top.length ? top[0].mm.toFixed(0) : '–';
    $('kRainAt').textContent = top.length ? 'มม. · ' + th(top[0].x.station.tele_station_name) : 'มม.';
    listInto('listRain', top.filter((s) => s.mm > 0).slice(0, 6), (s) => ({
      dot: s.mm > RAIN_HEAVY_MM ? heavyRed(s.mm) : rainStep(s.mm)[1], title: th(s.x.station.tele_station_name), sub: `${loc(s)} · ${fmtTime(s.t)}`, right: s.mm + ' มม.', go: s,
    }), 'ไม่มีฝนใน 24 ชม. ที่ผ่านมา');
    // ฝนตอนนี้: เรียงตามฝน 1 ชม. ล่าสุด (รวมสถานีรอบขอบ กทม.) เฉพาะค่าใน 2 ชม. ที่ผ่านมา
    const now1 = all.filter((s) => s.mm1 > 0 && Date.now() - s.t < 2 * 36e5).sort((a, b) => b.mm1 - a.mm1).slice(0, 6);
    listInto('listRain1', now1, (s) => ({ dot: LEVEL[rain1(s.mm1)[0]].color, title: th(s.x.station.tele_station_name), sub: `${loc(s)} · ${rain1(s.mm1)[1]} · ${fmtTime(s.t)}`, right: s.mm1 + ' มม./ชม.', go: s }),
      'ชั่วโมงล่าสุดไม่มีฝนที่สถานีใน กทม. และรอบ ๆ');
    renderBasin();
  }
  // ฝนลุ่มเจ้าพระยา: แต่ละจังหวัดแสดงฝนสูงสุด (และเฉลี่ย) 24 ชม. เรียงจากต้นน้ำลงมา
  function renderBasin() {
    const el = $('listBasin');
    if (!S.basin) { el.innerHTML = '<div class="muted small">ไม่มีข้อมูลฝน</div>'; return; }
    el.innerHTML = S.basin.map((b) => `<div class="row static"><span class="dot" style="--c:${b.n ? (b.max > RAIN_HEAVY_MM ? heavyRed(b.max) : rainStep(b.max)[1]) : 'var(--stale)'}"></span>
      <div class="t"><div>${esc(b.name)}</div><div class="s">${b.n ? `เฉลี่ย ${b.mean.toFixed(1)} มม. · ${b.n} สถานี${b.max > 0 ? ' · สูงสุดที่ ' + esc(b.maxAt) : ''}` : 'ไม่มีข้อมูล'}</div></div>
      <span class="n">${b.n ? b.max.toFixed(0) + ' มม.' : '–'}</span></div>`).join('');
  }

  // ---------- ThaiWater: พยากรณ์ฝน + เขื่อน (GitHub Actions ดึงมาเก็บใน data/thaiwater.json) ----------
  async function loadTw() {
    let d = null;
    try { d = await Flood.fetchTw(); } catch (e) { /* ยังไม่มีไฟล์ */ }
    const f = $('twFcst'), el = $('listDam');
    if (!d) { f.innerHTML = el.innerHTML = '<div class="muted small">ยังไม่มีข้อมูล</div>'; $('twTop').innerHTML = ''; return; }
    const bkk = Flood.twBkkHeavy(d);
    // ฝนหนักใน กทม. แจ้งไว้บนสุดของแท็บสรุปด้วย
    $('twTop').innerHTML = bkk ? `<div class="tw-alert on">🌧 ThaiWater คาดว่า <b>กรุงเทพฯ</b> มีฝนตกหนัก (ระดับ ${esc(bkk.level)}) · ดูภาพพยากรณ์ด้านล่าง</div>` : '';
    const near = (d.heavy || []).filter((p) => ['11', '12', '13', '73', '74'].includes(p.code)).map((p) => p.name);
    const imgs = (d.images || []).map((i) => ({ ...i, file: /^data\//.test(i.file) ? i.file : 'data/' + i.file }));
    const grp = [...new Set(imgs.map((i) => i.group))];
    f.innerHTML = `<div class="tw-alert ${bkk ? 'on' : ''}">${bkk ? `⚠️ ThaiWater คาดว่า <b>กรุงเทพฯ</b> มีฝนตกหนัก (ระดับ ${esc(bkk.level)})` : 'ThaiWater ไม่ได้ระบุ กทม. ในจังหวัดที่คาดว่าฝนตกหนัก'}${near.length ? `<br><span class="small">จังหวัดรอบ ๆ ที่คาดว่าฝนหนัก: ${esc(near.join(', '))}</span>` : ''}</div>`
      + grp.map((g) => `<div class="tw-imgs"><div class="small muted">ภาพจำลองฝน ${esc(g)}</div><div class="tw-row">${imgs.filter((i) => i.group === g).map((i) =>
        `<a href="${esc(i.file)}" target="_blank" rel="noopener"><img src="${esc(i.file)}?v=${encodeURIComponent(i.datetime || '')}" alt="พยากรณ์ฝน${esc(g)} วันที่ ${i.day}" loading="lazy"><span>วันที่ ${i.day}</span></a>`).join('')}</div></div>`).join('')
      + `<div class="muted small">แบบจำลองสภาพอากาศของ สสน. (ThaiWater) คาดการณ์ล่วงหน้า อัปเดตวันละครั้ง · ปรับเมื่อ ${imgs[0] ? esc(imgs[0].datetime) : '–'} · กดที่ภาพเพื่อดูขนาดเต็ม</div>`
      + (d.storms && d.storms.length ? `<div class="tw-imgs"><div class="small muted">🌀 ภาพติดตามพายุล่าสุด (รวบรวมโดย ThaiWater จากหลายแหล่ง)</div><div class="tw-row storm">${d.storms.map((m) =>
        `<a href="${esc(m.file)}" target="_blank" rel="noopener"><img src="${esc(m.file)}?v=${encodeURIComponent(m.datetime || '')}" alt="ภาพติดตามพายุ ${esc(m.source || m.key)}" loading="lazy"><span>${esc(m.source || m.key)} · ${esc(String(m.datetime || '').slice(5, 16))}</span></a>`).join('')}</div></div>` : '');
    el.innerHTML = (d.dams || []).map((m) => {
      const lv = m.pct >= 100 ? 3 : m.pct >= 90 ? 2 : m.pct >= 80 ? 1 : 0;
      return `<div class="row static"><span class="dot" style="--c:${LEVEL[lv].color}"></span>
        <div class="t"><div>เขื่อน${esc(m.name)} <span class="muted small">${esc(m.province)}</span></div>
        <div class="s">น้ำไหลเข้า ${fmtN(m.inflow)} · ปล่อยออก ${fmtN(m.released)}${m.spilled ? ' · ล้นทางระบาย ' + fmtN(m.spilled) : ''} ล้าน ลบ.ม./วัน · ${esc(m.date)}</div></div>
        <span class="n">${m.pct != null ? Number(m.pct).toFixed(0) + '%' : '–'}</span></div>`;
    }).join('') + '<div class="muted small">% = ปริมาณน้ำในอ่างเทียบความจุ · เขื่อนปล่อยน้ำมากขึ้นจะส่งผลถึงแม่น้ำเจ้าพระยาช่วง กทม. ภายในหลายวัน</div>';
  }
  const fmtN = (v) => (v == null || isNaN(v) ? '–' : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 }));

  // ฝนหนัก: แดงอ่อน (35 มม.) → แดงเข้ม (≥ 150 มม.) ไล่ตามปริมาณฝน
  function heavyRed(mm) {
    const t = Math.max(0, Math.min(1, (mm - RAIN_HEAVY_MM) / (150 - RAIN_HEAVY_MM)));
    const from = [245, 150, 146], to = [122, 14, 10];
    return 'rgb(' + from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(',') + ')';
  }

  // ความแรงฝนรายชั่วโมง (เกณฑ์กรมอุตุฯ โดยประมาณ)
  const rain1 = (mm) => (mm >= 30 ? [3, 'หนักมาก'] : mm >= 10 ? [2, 'หนัก'] : mm >= 2.5 ? [1, 'ปานกลาง'] : [0, 'เล็กน้อย']);
  // ตำแหน่ง: ใน กทม. บอกเขต, รอบขอบบอกอำเภอ/จังหวัด
  const loc = (s) => (s.edge ? `อ.${th(s.x.geocode.amphoe_name)} จ.${th(s.x.geocode.province_name)} (นอก กทม.)` : `เขต${th(s.x.geocode.amphoe_name)}`);

  // ---------- 5) ThaiWater ระดับน้ำ ----------
  async function loadWl() {
    setFeed('wl', 'loading');
    try {
      const r = await Flood.fetchWl();
      S.wl = r.items; S.wlEdge = (r.edge || []).map((x) => ({ ...x, edge: true })); S.cpy = r.upstream;
      setFeed('wl', 'ok', r.msg, r.newest);
    } catch (e) { S.wl = null; setFeed('wl', 'fail', Flood.errMsg('wl', e)); }
    drawWl();
  }
  // น้ำเหนือ: สถานีบนแม่น้ำเจ้าพระยาเรียงจากต้นน้ำ กดแล้วไปที่สถานีบนแผนที่
  function renderCpy() {
    const el = $('listCpy');
    if (!S.cpy) { el.innerHTML = '<div class="muted small">ไม่มีข้อมูลระดับน้ำ</div>'; return; }
    const rows = S.cpy;
    el.innerHTML = rows.map((c, i) => {
      if (c.missing) return `<div class="row static"><span class="dot" style="--c:var(--stale)"></span><div class="t"><div>${esc(c.label)}</div><div class="s">ไม่มีข้อมูลสถานี ${esc(c.code)}</div></div></div>`;
      const lv = c.pct != null ? wlLevel(c.pct) : 0;
      const right = c.code === 'C.13' && c.q != null ? c.q.toLocaleString() + ' ลบ.ม./วิ' : c.pct != null ? c.pct.toFixed(0) + '%' : '–';
      return `<div class="row" data-i="${i}" tabindex="0"><span class="dot" style="--c:${c.stale ? 'var(--stale)' : LEVEL[lv].color}"></span>
        <div class="t"><div>${esc(c.label)}</div><div class="s">${c.pct != null ? c.pct.toFixed(0) + '% ของตลิ่ง · ' : ''}${trend(c) || 'ไม่มีแนวโน้ม'}${c.q != null ? ' · ไหล ' + c.q.toLocaleString() + ' ลบ.ม./วิ' : ''} · ${fmtTime(c.t)}${c.stale ? ' (ค่าเก่า)' : ''}</div></div>
        <span class="n">${right}</span></div>`;
    }).join('') + '<div class="muted small">C.13 = ปริมาณน้ำที่ปล่อยจากเขื่อนเจ้าพระยา ยิ่งมากน้ำจะมาถึง กทม. ใน 1–3 วัน · ระดับน้ำใน กทม. ขึ้นลงตามน้ำทะเลหนุนด้วย</div>';
    el.querySelectorAll('.row[data-i]').forEach((r) => r.onclick = () => {
      const c = rows[+r.dataset.i];
      if (!c.la) return;
      map.setView([c.la, c.lo], 13);
      L.popup().setLatLng([c.la, c.lo]).setContent(`<div class="pp"><div class="m">น้ำเหนือ · ${esc(c.code)}</div><h3>${esc(c.label)}</h3>
        <div><span class="big">${c.msl != null ? c.msl.toFixed(2) : '–'}</span> ม.รทก. <span class="m">${trend(c)}</span></div>
        <div class="m">${c.pct != null ? c.pct.toFixed(0) + '% ของตลิ่ง · ' : ''}ตลิ่ง ${c.bank != null ? c.bank.toFixed(2) + ' ม.รทก.' : '–'}${c.q != null ? '<br>ปริมาณน้ำไหล ' + c.q.toLocaleString() + ' ลบ.ม./วินาที' : ''}<br>${fmtDT(c.t)}</div></div>`).openOn(map);
      minimizePanel();
    });
  }
  // แนวโน้มสถานี ThaiWater: เทียบกับค่าก่อนหน้าของสถานี (ม.) ⬆⬆ ≥ 0.10 · ⬆ ≥ 0.03 · ⬇ ≤ −0.03 · ⬇⬇ ≤ −0.10
  function wlTr(s) {
    if (s.msl == null || s.prev == null || s.stale) return '';
    const d = s.msl - s.prev;
    return d >= 0.1 ? 'fast' : d >= 0.03 ? 'up' : d <= -0.1 ? 'dfast' : d <= -0.03 ? 'down' : 'flat';
  }
  function trend(s) {
    if (s.msl == null || s.prev == null) return '';
    const d = s.msl - s.prev, k = wlTr(s) || 'flat';
    return `${TRL[k][0]} ${TRL[k][1]}${Math.abs(d) >= 0.005 ? ` (${d > 0 ? '+' : ''}${d.toFixed(2)} ม. จากค่าก่อนหน้า)` : ''}`;
  }
  function drawWl() {
    layers.wl.clearLayers();
    if (!S.wl) { $('listWl').innerHTML = '<div class="muted small">ไม่มีข้อมูลระดับน้ำ</div>'; return; }
    const allWl = [...S.wl, ...(S.wlEdge || [])];
    for (const s of allWl) {
      const lv = s.pct != null ? wlLevel(s.pct) : 0;
      const html = `<div class="pp"><div class="m">สถานีวัดระดับน้ำ · ${esc(th(s.x.agency && s.x.agency.agency_shortname))}</div><h3>${esc(th(s.x.station.tele_station_name))}</h3>
        ${s.pct != null ? badge(lv, `${s.pct.toFixed(0)}% ของตลิ่ง`) : ''} ${s.stale ? '<span class="badge" style="--c:var(--stale)">ค่าเก่า</span>' : ''}
        <div style="margin-top:4px"><span class="big">${s.msl != null ? s.msl.toFixed(2) : '–'}</span> ม.รทก. <span class="m">${trend(s)}</span></div>
        <div class="m">ตลิ่งต่ำสุด ${s.bank != null ? s.bank.toFixed(2) + ' ม.รทก.' : '–'} · ${esc(loc(s))}<br>${fmtDT(s.t)} (${ago(s.t)})</div></div>`;
      const k = wlTr(s);
      s.marker = L.marker([s.la, s.lo], { icon: icon('wl', LEVEL[lv].color, '', 18, s.stale ? 'stale' : '', k && k !== 'flat' ? TRL[k][0] : ''), zIndexOffset: 200 }).bindPopup(html).addTo(layers.wl);
    }
    const hi = allWl.filter((s) => !s.stale && s.pct != null).sort((a, b) => b.pct - a.pct).slice(0, 6);
    listInto('listWl', hi, (s) => ({ dot: LEVEL[wlLevel(s.pct)].color, title: th(s.x.station.tele_station_name), sub: `${s.edge ? loc(s) + ' · ' : ''}${trend(s) || 'ไม่มีแนวโน้ม'} · ${fmtTime(s.t)}`, right: s.pct.toFixed(0) + '%', go: s }), 'ไม่มีสถานีที่มีค่าล่าสุด');
    renderCpy();
  }

  // ---------- 5b) สำนักการระบายน้ำ กทม. ผ่านเครื่องในไทย: คลอง 312 สถานี, ฝน, อุโมงค์ทางลอด ----------
  const CANAL = { 2: ['วิกฤต', 3], 1: ['เตือนภัย', 2], 0: ['ปกติ', 0], '-1': ['ขัดข้อง', -1] };
  async function loadRelay() {
    setFeed('relay', 'loading');
    const b = await Flood.fetchBmaRelay();
    S.relay = b;
    if (!b) setFeed('relay', 'off', 'ต้องมีเครื่องในไทยส่งข้อมูล (ข้อมูลเก่ากว่า 90 นาทีจะไม่แสดง)');
    else {
      const crit = (b.canal || []).filter((c) => c.st === 2).length;
      const via = b.source === 'thaiwater' ? 'ผ่าน ThaiWater (ไม่มีฝน/อุโมงค์)' : 'ผ่านเครื่องในไทย';
      setFeed('relay', 'ok', `${via} · คลอง ${(b.canal || []).length} สถานี (วิกฤต ${crit})${(b.rain || []).length ? ` · ฝน ${b.rain.length} สถานี` : ''}${(b.road || []).some((r) => r.tunnel) ? ` · อุโมงค์ ${b.road.filter((r) => r.tunnel).length} แห่ง` : ''}`, new Date(b.updated));
    }
    drawRelay();
  }
  function drawRelay() {
    layers.canal.clearLayers(); layers.bmaRain.clearLayers();
    const b = S.relay;
    $('secCanal').hidden = !b || !(b.canal || []).length;
    $('secTunnel').hidden = !b || !(b.road || []).some((r) => r.tunnel);
    $('secBmaRain').hidden = !b || !(b.rain || []).length;
    if (!b) return;
    // คลอง: ปกติ/ขัดข้องจุดเล็ก เตือนภัย/วิกฤตจุดใหญ่
    for (const c of b.canal || []) {
      const [label, lv] = CANAL[c.st] || CANAL['-1'];
      const color = lv < 0 ? 'var(--stale)' : LEVEL[lv].color;
      const html = `<div class="pp"><div class="m">ระดับน้ำคลอง · สำนักการระบายน้ำ กทม.</div><h3>${esc(c.n)}</h3>
        <span class="badge" style="--c:${color}">${label}</span>
        ${c.wl != null && lv >= 0 ? `<div style="margin-top:4px"><span class="big">${c.wl.toFixed(2)}</span> ม.</div>` : ''}
        <div class="m">${c.warn != null ? `เกณฑ์เตือนภัย ${c.warn} · วิกฤต ${c.crit} · ` : ''}${c.river ? esc(c.river) + ' · ' : ''}เขต${esc(c.d)}${c.t ? `<br>${fmtDT(new Date(c.t))} (${ago(new Date(c.t))})` : ''}</div>${trendHtml(S.trend && S.trend.canal.get(c.c), ' ม.', 2)}</div>`;
      const ctr = S.trend && S.trend.canal.get(c.c), arrow = ctr && TRL[ctr.tr] && ctr.tr !== 'flat' && lv >= 0 ? TRL[ctr.tr][0] : '';
      const size = c.st >= 1 ? 13 : arrow ? 10 : 7;
      c.marker = L.marker([c.la, c.lo], { icon: icon('wl', color, '', size, lv < 0 ? 'stale' : '', arrow), zIndexOffset: c.st * 100 + (arrow ? 50 : 0) }).bindPopup(html).addTo(layers.canal);
    }
    const hot = (b.canal || []).filter((c) => c.st >= 1).sort((x, y) => y.st - x.st || (y.wl - y.crit) - (x.wl - x.crit));
    listInto('listCanal', hot.slice(0, 8), (c) => ({ dot: LEVEL[CANAL[c.st][1]].color, title: c.n, sub: `${CANAL[c.st][0]} · เขต${c.d}${c.t ? ' · ' + fmtTime(new Date(c.t)) : ''}`, right: c.wl != null ? c.wl.toFixed(2) + ' ม.' : '', go: c }),
      'ไม่มีคลองที่อยู่ในระดับเตือนภัยหรือวิกฤต');
    $('canalSum').textContent = `วิกฤต ${hot.filter((c) => c.st === 2).length} · เตือนภัย ${hot.filter((c) => c.st === 1).length} · ปกติ ${(b.canal || []).filter((c) => c.st === 0).length} · ขัดข้อง ${(b.canal || []).filter((c) => c.st < 0).length} สถานี`;
    // อุโมงค์ทางลอด
    const tun = (b.road || []).filter((r) => r.tunnel).sort((x, y) => (y.cm || 0) - (x.cm || 0));
    for (const r of tun) r.marker = null;
    listInto('listTunnel', tun, (r) => ({
      dot: r.st === 'off' ? 'var(--stale)' : r.cm >= 5 ? LEVEL[Flood.sensorLevel(r.cm) || 1].color : LEVEL[0].color,
      title: r.n + (r.dir ? ` (${r.dir})` : ''), sub: `${r.st === 'off' ? 'เซ็นเซอร์ขัดข้อง' : r.cm >= 5 ? 'มีน้ำ' : 'ปกติ'} · เขต${r.d}${r.t ? ' · ' + fmtTime(new Date(r.t)) : ''}`,
      right: r.st === 'off' ? '–' : (r.cm || 0) + ' ซม.', go: r,
    }), 'ไม่มีข้อมูลอุโมงค์');
    // ฝนสถานี กทม.
    for (const r of b.rain || []) {
      if (r.r24 == null) continue;
      const st = rainStep(r.r24), heavy = r.r24 > RAIN_HEAVY_MM;
      const html = `<div class="pp"><div class="m">สถานีวัดฝน · สำนักการระบายน้ำ กทม.</div><h3>${esc(r.n)}</h3>
        <div><span class="big">${r.r24}</span> มม. / 24 ชม.</div><div>15 นาที ${r.r15 ?? '–'} · 1 ชม. ${r.r1 ?? '–'} · 3 ชม. ${r.r3 ?? '–'} มม.</div>
        <div class="m">เขต${esc(r.d)}${r.t ? ' · ' + fmtDT(new Date(r.t)) : ''}</div></div>`;
      r.marker = L.circleMarker([r.la, r.lo], { radius: Math.min(11, 2 + Math.sqrt(Math.max(0, r.r24)) * 0.7), color: '#fff', weight: 1, fillOpacity: r.r24 > 0 ? 0.85 : 0.3,
        fillColor: heavy ? heavyRed(r.r24) : cssVar(st[1].slice(4, -1)) }).bindPopup(html).addTo(layers.bmaRain);
    }
    const now = (b.rain || []).filter((r) => r.r1 > 0 && r.t && Date.now() - r.t < 2 * 36e5).sort((x, y) => y.r1 - x.r1 || y.r15 - x.r15);
    listInto('listBmaRain', now.slice(0, 6), (r) => ({ dot: LEVEL[rain1(r.r1)[0]].color, title: r.n, sub: `เขต${r.d} · 15 นาที ${r.r15 ?? 0} มม. · ${fmtTime(new Date(r.t))}`, right: r.r1 + ' มม./ชม.', go: r }),
      'ชั่วโมงล่าสุดไม่มีฝนที่สถานีของ กทม.');
  }

  // ---------- 6) ข่าว + สรุป AI (จาก GitHub Actions) ----------
  let newsFilter = 'all';
  const isYt = (n) => n.kind === 'youtube';
  const ytThumb = (n) => /^https:\/\/i\.ytimg\.com\//.test(n.thumb || '') ? n.thumb : '';
  async function loadNews() {
    setFeed('news', 'loading'); setFeed('youtube', 'loading');
    try {
      const d = await Flood.fetchNews();
      S.news = d.items;
      const src = d.sources;
      const ai = src.news && src.news.ai;
      $('newsNote').textContent = `ข่าวและคลิปเกี่ยวกับน้ำท่วมใน กทม. ช่วง 48 ชม. อัปเดตล่าสุด ${fmtDT(d.updated)}` +
        (ai === 'ok' ? ' · สรุปและระบุตำแหน่งโดย AI (Gemini) อาจคลาดเคลื่อน โปรดดูต้นฉบับ' : ' · ยังไม่ได้เปิดใช้สรุปด้วย AI (แสดงเฉพาะหัวข้อ และปักหมุดระดับเขต)');
      const nNews = S.news.filter((n) => !isYt(n)).length, nYt = S.news.length - nNews;
      if (src.news && src.news.ok === false) setFeed('news', 'fail', src.news.error || 'ดึงข่าวไม่สำเร็จ');
      else setFeed('news', 'ok', `${nNews} ข่าว`, d.updated);
      const yt = src.youtube;
      // ยังไม่ได้ใส่ key ไม่ใช่ความผิดพลาด ไม่ต้องขึ้นคำเตือนสีแดง
      if (!yt || yt.status === 'no-key') setFeed('youtube', 'off', 'ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY');
      else if (!yt.ok) setFeed('youtube', 'fail', yt.status || yt.error || 'ค้นไม่สำเร็จ');
      else setFeed('youtube', 'ok', `${nYt} คลิป`, d.updated);
    } catch (e) { S.news = null; setFeed('news', 'fail', 'ยังไม่มีไฟล์ข่าว (' + e.message + ')'); setFeed('youtube', 'fail', 'ยังไม่มีไฟล์ข่าว'); }
    drawNews();
  }
  function drawNews() {
    layers.news.clearLayers();
    if (!S.news) { $('kNews').textContent = '–'; $('listNews').innerHTML = '<div class="muted small">ยังไม่มีข้อมูลข่าว</div>'; return; }
    $('kNews').textContent = S.news.length;
    S.news.forEach((n) => {
      const lv = SEV_LV[n.severity] || 2;
      const th = ytThumb(n);
      n.markers = (n.pins || []).map((p) => {
        const html = `<div class="pp">${badge(lv, 'ความรุนแรง' + (n.severity || ''))} <span class="m">${isYt(n) ? '▶ YouTube · ' : ''}${esc(n.source)} · ${fmtDT(new Date(n.published))}</span>
          <h3>${esc(n.title)}</h3>
          ${th ? `<a href="${esc(n.link)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(th)}" alt="ภาพตัวอย่างคลิป"></a>` : ''}
          ${n.summary ? `<div>${esc(n.summary)}</div>` : ''}
          <div class="m" style="margin-top:6px">ตำแหน่ง: ${esc(p.label)}${p.precision === 'district' ? ' (โดยประมาณระดับเขต)' : ''}<br>
          <a href="${esc(n.link)}" target="_blank" rel="noopener">${isYt(n) ? 'ดูคลิปบน YouTube' : 'อ่านข่าวต้นฉบับ'}</a></div></div>`;
        // ข่าวที่รายงานน้ำท่วมจริง (ความรุนแรงสูง/กลาง) = หมุดแดง ส่วนข่าวเตือนภัย/น้ำลดแล้ว (ต่ำ) = ม่วง
        const flooded = lv >= 2;
        const color = isYt(n) ? 'var(--yt)' : flooded ? 'var(--critical)' : 'var(--news)';
        return L.marker([p.lat, p.lng], { icon: icon('news', color, '', isYt(n) ? 6 : p.precision === 'district' ? 16 : 20, isYt(n) ? 'yt' : ''), zIndexOffset: flooded ? 350 : 300 })
          .bindPopup(html, { maxWidth: 320 }).addTo(layers.news);
      });
    });
    renderNewsList();
  }
  function renderNewsList() {
    const counts = { all: S.news.length, news: S.news.filter((n) => !isYt(n)).length, youtube: S.news.filter(isYt).length };
    $('newsFilter').innerHTML = [['all', 'ทั้งหมด'], ['news', 'ข่าว'], ['youtube', 'YouTube']]
      .map(([k, t]) => `<button type="button" data-f="${k}" class="${newsFilter === k ? 'on' : ''}" aria-pressed="${newsFilter === k}">${t} ${counts[k]}</button>`).join('');
    $('newsFilter').querySelectorAll('button').forEach((b) => b.onclick = () => { newsFilter = b.dataset.f; renderNewsList(); });
    const shown = S.news.map((n, i) => [n, i]).filter(([n]) => newsFilter === 'all' || (newsFilter === 'youtube') === isYt(n));
    $('listNews').innerHTML = shown.length ? shown.map(([n, i]) => {
      const lv = SEV_LV[n.severity] || 2;
      const th = ytThumb(n);
      return `<article>
        <div class="meta">${badge(lv, 'ความรุนแรง' + (n.severity || ''))}${isYt(n) ? `<span class="yt-tag">${n.live ? '● LIVE' : '▶ YouTube'}</span>` : ''}<span>${esc(n.source)}</span><span>${fmtDT(new Date(n.published))}</span></div>
        <h3><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
        ${th ? `<button type="button" class="yt-thumb" data-v="${esc(n.videoId)}" aria-label="เล่นคลิป ${esc(n.title)}"><img loading="lazy" src="${esc(th)}" alt=""><span>▶</span></button>` : ''}
        ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
        ${(n.pins || []).length ? `<div class="pins">${n.pins.map((p, j) => `<button type="button" data-n="${i}" data-p="${j}">📍 ${esc(p.label)}</button>`).join('')}</div>` : ''}
      </article>`;
    }).join('') : '<div class="muted small">ยังไม่พบข่าวหรือคลิปน้ำท่วมใน กทม. ช่วง 48 ชม.</div>';
    $('listNews').querySelectorAll('.pins button').forEach((b) => b.onclick = () => {
      const n = S.news[+b.dataset.n], m = n.markers[+b.dataset.p];
      if (!map.hasLayer(layers.news)) map.addLayer(layers.news);
      map.setView(m.getLatLng(), 15); m.openPopup(); minimizePanel();
    });
    // กดภาพตัวอย่างแล้วเล่นคลิปในหน้า (โหมด privacy-enhanced ไม่ฝังคุกกี้จนกว่าจะเล่น)
    $('listNews').querySelectorAll('.yt-thumb').forEach((b) => b.onclick = () => {
      if (!/^[\w-]{6,20}$/.test(b.dataset.v)) return;
      const f = document.createElement('iframe');
      f.className = 'yt-frame';
      f.src = `https://www.youtube-nocookie.com/embed/${b.dataset.v}?autoplay=1&rel=0`;
      f.title = 'คลิป YouTube';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      b.replaceWith(f);
    });
  }

  // ---------- Facebook Page Plugin ----------
  // โหลด iframe เฉพาะตอนเปิดแท็บ (ไม่ให้ Facebook โหลดกับทุกคนที่เข้าเว็บ)
  const FB_KEY = 'bkkflood.fbPage';
  let fbPages = null, fbCurrent = null;
  async function openFacebook() {
    if (!fbPages) {
      try { fbPages = ((await getJSON(URL.fbPages)).pages || []).filter((p) => /^https:\/\/(www\.)?facebook\.com\//.test(p.url)); }
      catch (e) { $('fbBox').innerHTML = '<div class="muted small">โหลดรายชื่อเพจไม่ได้</div>'; return; }
      let saved = null;
      try { saved = localStorage.getItem(FB_KEY); } catch (e) { /* ใช้ค่าเริ่มต้น */ }
      fbCurrent = fbPages.find((p) => p.url === saved) || fbPages[0];
    }
    if (!fbCurrent) { $('fbBox').innerHTML = '<div class="muted small">ยังไม่ได้ตั้งค่ารายชื่อเพจ</div>'; return; }
    $('fbPages').innerHTML = fbPages.map((p, i) => `<button type="button" data-i="${i}" class="${p === fbCurrent ? 'on' : ''}" aria-pressed="${p === fbCurrent}">${esc(p.name)}</button>`).join('');
    $('fbPages').querySelectorAll('button').forEach((b) => b.onclick = () => {
      fbCurrent = fbPages[+b.dataset.i];
      try { localStorage.setItem(FB_KEY, fbCurrent.url); } catch (e) { /* ไม่เป็นไร */ }
      openFacebook();
    });
    const box = $('fbBox');
    // Page Plugin รองรับความกว้าง 180–500 px
    const w = Math.max(180, Math.min(500, Math.floor(box.clientWidth || 340)));
    const h = Math.max(500, Math.floor(box.closest('.tab').clientHeight - box.offsetTop - 40));
    const src = 'https://www.facebook.com/plugins/page.php?' + new URLSearchParams({
      href: fbCurrent.url, tabs: 'timeline', width: w, height: h, small_header: 'true',
      adapt_container_width: 'true', hide_cover: 'false', show_facepile: 'false', locale: 'th_TH',
    });
    if (box.dataset.src !== src) {
      box.dataset.src = src;
      box.innerHTML = `<iframe src="${esc(src)}" width="${w}" height="${h}" title="โพสต์จากเพจ ${esc(fbCurrent.name)}" loading="lazy"
        scrolling="no" allowfullscreen allow="clipboard-write; encrypted-media; picture-in-picture; web-share"></iframe>`;
    }
    $('fbNote').innerHTML = `<a href="${esc(fbCurrent.url)}" target="_blank" rel="noopener">เปิดเพจ ${esc(fbCurrent.name)} ใน Facebook</a> · ถ้าไม่เห็นโพสต์ อาจเป็นเพราะเบราว์เซอร์หรือส่วนขยายบล็อกเนื้อหาจาก Facebook ให้กดลิงก์เพื่อเปิดเพจโดยตรง`;
  }

  // ---------- 7) ประกาศกรมอุตุฯ ----------
  async function loadTmd() {
    setFeed('tmd', 'loading');
    try {
      const d = await Flood.fetchTmd();
      const items = d.items.slice(0, 2);
      $('tmd').innerHTML = items.map((x) => `<div class="tmd" tabindex="0"><h3>⚠ ${esc(x.title)}</h3><p>${esc(x.description)}</p>
        <div class="muted small">กรมอุตุนิยมวิทยา · ${esc(x.announced)}${x.file ? ` · <a href="${esc(x.file)}" target="_blank" rel="noopener">เอกสาร</a>` : ''}</div></div>`).join('');
      $('tmd').querySelectorAll('.tmd').forEach((el) => el.onclick = () => el.classList.toggle('open'));
      setFeed('tmd', 'ok', `${d.items.length} ประกาศ`, d.updated);
    } catch (e) { $('tmd').innerHTML = ''; setFeed('tmd', 'fail', 'ยังไม่มีไฟล์ประกาศ (' + e.message + ')'); }
  }

  // ---------- 8) กล้อง CCTV สาธารณะ ----------
  async function loadCams() {
    setFeed('cam', 'loading');
    try {
      const d = await Flood.fetchCams();
      if (!Array.isArray(d)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      // เฉพาะกล้องที่เผยแพร่สาธารณะผ่าน HTTPS: วิดีโอสด (HLS) หรือภาพนิ่ง
      S.cam = d.map((c) => ({ c, la: num(c.latitude), lo: num(c.longitude),
        video: /^https:\/\//.test(c.hls_url || '') && !/tempsus/.test(c.hls_url), still: /^https:\/\//.test(c.imgurl || '') && !/X\.X\.X\.X/.test(c.imgurl) }))
        .filter((x) => x.la && x.lo && inBkk(x.la, x.lo) && (x.video || x.still));
      const nv = S.cam.filter((x) => x.video).length;
      setFeed('cam', 'ok', `${S.cam.length} กล้อง (วิดีโอสด ${nv} · ภาพนิ่ง ${S.cam.length - nv})`);
    } catch (e) { S.cam = null; setFeed('cam', 'fail', e.message); }
    drawCams();
  }
  let hls = null, stillTimer = null;
  function stopStream() {
    if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; }
    clearInterval(stillTimer); stillTimer = null;
  }
  // กล้องภาพนิ่ง: โหลดภาพใหม่ทุก 60 วินาทีระหว่างเปิดป๊อปอัป
  function showStill(el, x, note) {
    const st = el.querySelector('.camst'), v = el.querySelector('video');
    if (v) v.remove();
    const img = new Image(); img.referrerPolicy = 'no-referrer'; img.alt = 'ภาพนิ่งจากกล้อง';
    const load = () => { img.src = x.c.imgurl + (x.c.imgurl.includes('?') ? '&' : '?') + '_t=' + Date.now(); };
    img.onload = () => { st.textContent = note + ' · ' + fmtTime(new Date()); };
    img.onerror = () => { st.textContent = 'ไม่สามารถแสดงภาพจากกล้องนี้ได้ขณะนี้'; };
    st.before(img); st.textContent = 'กำลังโหลดภาพ…'; load();
    stillTimer = setInterval(load, 60000);
  }
  function startStream(el, x) {
    stopStream();
    if (!x.video) { showStill(el, x, 'ภาพนิ่ง (โหลดใหม่ทุก 1 นาที)'); return; }
    const v = el.querySelector('video'), st = el.querySelector('.camst');
    const fail = (why) => {
      v.remove();
      const snap = x.c.imgurl && !/X\.X\.X\.X/.test(x.c.imgurl) ? x.c.imgurl : '';
      if (snap) {
        const img = new Image(); img.referrerPolicy = 'no-referrer'; img.alt = 'ภาพนิ่งจากกล้อง';
        img.src = snap + (snap.includes('?') ? '&' : '?') + '_t=' + Date.now();
        img.onerror = () => { st.textContent = 'ไม่สามารถแสดงภาพจากกล้องนี้ได้ขณะนี้'; img.remove(); };
        st.before(img); st.textContent = 'ภาพสดใช้ไม่ได้ (' + why + ') แสดงภาพนิ่งแทน';
      } else st.textContent = 'ภาพสดใช้ไม่ได้ขณะนี้ (' + why + ')';
    };
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 1 });
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stopStream(); fail(d.details || 'error'); } });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { st.textContent = '● ภาพสด'; });
      hls.loadSource(x.c.hls_url); hls.attachMedia(v); v.play().catch(() => {});
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = x.c.hls_url; v.onplaying = () => { st.textContent = '● ภาพสด'; }; v.onerror = () => fail('error'); v.play().catch(() => {});
    } else fail('เบราว์เซอร์ไม่รองรับ');
  }
  function drawCams() {
    layers.cam.clearLayers();
    if (!S.cam) return;
    for (const x of S.cam) {
      x.marker = L.marker([x.la, x.lo], { icon: icon('cam', x.video ? '#1d2330' : '#4a5568', x.video ? '▶' : '◻', 12), zIndexOffset: -100 })
        .bindPopup(() => `<div class="pp" style="width:290px;max-width:100%"><div class="m">${esc(x.c.organization || '')} · ${esc(x.c.camid)}</div><h3>${esc(x.c.title)}</h3>
          ${x.video ? '<video muted autoplay playsinline controls></video>' : ''}<div class="m camst">กำลังเชื่อมต่อ…</div>
          <div class="m">ภาพจาก ${esc(x.c.sponsertext || x.c.organization || 'iTIC')} ผ่าน iTIC / Longdo</div></div>`, { maxWidth: 310, minWidth: 250 })
        .on('popupopen', (e) => startStream(e.popup.getElement(), x))
        .on('popupclose', stopStream)
        .addTo(layers.cam);
    }
    renderCams();
  }
  function renderCams() {
    if (!S.cam) { $('listCam').innerHTML = '<div class="muted small">โหลดรายการกล้องไม่ได้</div>'; return; }
    const spots = [...(S.sensor || []).filter((x) => x.lv > 0).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: x.s.name || x.s.road })),
      ...(S.event || []).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: x.e.title })),
      ...(S.traffy || []).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: x.r.address || 'จุดที่ประชาชนแจ้ง' }))];
    const pairs = [], seen = new Set();
    for (const sp of spots.sort((a, b) => b.lv - a.lv)) {
      let best = null;
      for (const cm of S.cam) { const d = distKm(sp.la, sp.lo, cm.la, cm.lo); if (d <= CAM_NEAR_KM && (!best || d < best.d)) best = { cm, d }; }
      if (best && !seen.has(best.cm.c.camid)) { seen.add(best.cm.c.camid); pairs.push({ sp, ...best }); }
    }
    listInto('listCam', pairs.slice(0, 20), (p) => ({ dot: LEVEL[p.sp.lv].color, title: p.cm.c.title, sub: `ห่าง ${(p.d * 1000).toFixed(0)} ม. จาก ${p.sp.name}`, right: '▶', go: p.cm, cam: true }),
      'ไม่มีกล้องสาธารณะใกล้จุดน้ำท่วมในขณะนี้ (กล้องทั้งหมดแสดงบนแผนที่ ▶ = วิดีโอสด · ◻ = ภาพนิ่ง กดเพื่อดู)');
  }

  // ---------- 9) เรดาร์ฝน ----------
  async function loadRadar() {
    setFeed('radar', 'loading');
    try {
      const d = await Flood.fetchRadar();
      const f = d.radar && d.radar.past && d.radar.past[d.radar.past.length - 1];
      if (!f) throw new Error('ไม่มีภาพเรดาร์');
      layers.radar.clearLayers();
      L.tileLayer(d.host + f.path + '/256/{z}/{x}/{y}/2/1_1.png', { opacity: 0.5, maxNativeZoom: 7, maxZoom: 19, attribution: 'เรดาร์ © RainViewer' }).addTo(layers.radar);
      setFeed('radar', 'ok', '', new Date(f.time * 1000));
    } catch (e) { setFeed('radar', 'fail', e.message); }
  }

  // ---------- ขอบเขตเขต ----------
  async function loadDistricts() {
    try {
      const g = await Flood.loadDistricts();
      L.geoJSON(g, {
        style: { color: dark ? '#6d7682' : '#7d8896', weight: 1, opacity: 0.6, fill: false, dashArray: '3 3' },
        interactive: false,
      }).addTo(layers.districts);
    } catch (e) { /* ไม่มีขอบเขตก็ยังใช้งานได้ */ }
  }

  // ---------- รายการในแผงข้าง ----------
  function listInto(id, arr, fn, empty) {
    const el = $(id);
    if (!arr.length) { el.innerHTML = `<div class="muted small">${esc(empty)}</div>`; return; }
    const rows = arr.map(fn);
    el.innerHTML = rows.map((r, i) => `<div class="row" data-i="${i}" tabindex="0"><span class="dot" style="--c:${r.dot}"></span>
      <div class="t"><div>${esc(r.title)}</div><div class="s">${esc(r.sub)}</div></div><span class="n">${esc(r.right)}</span></div>`).join('');
    el.querySelectorAll('.row').forEach((row) => {
      const go = () => {
        const r = rows[+row.dataset.i];
        if (r.cam && !map.hasLayer(layers.cam)) map.addLayer(layers.cam);
        map.setView([r.go.la, r.go.lo], 15);
        if (r.go.marker) r.go.marker.openPopup();
        minimizePanel();
      };
      row.onclick = go;
      row.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
  }
  function renderFloodList() {
    const all = [
      ...(S.sensor || []).filter((x) => x.lv > 0).map((x) => ({ dot: LEVEL[x.lv].color, lv: x.lv, title: x.s.name || x.s.road, sub: `เซ็นเซอร์ กทม. · ${LEVEL[x.lv].label} · ${fmtTime(x.t)}`, right: Math.round(x.cm) + ' ซม.', go: x, t: x.t })),
      ...(S.event || []).map((x) => ({ dot: LEVEL[x.lv].color, lv: x.lv, title: String(x.e.title).replace(/^น้ำท่วม\s*/, ''), sub: `${x.why} · ${fmtTime(x.start)}`, right: LEVEL[x.lv].label, go: x, t: x.start })),
    ].sort((a, b) => b.lv - a.lv || (b.t || 0) - (a.t || 0));
    renderPlaces();
    listInto('listFlood', all.slice(0, 15), (r) => r, S.sensor || S.event ? 'ยังไม่มีรายงานถนนน้ำท่วมจากเซ็นเซอร์และหน่วยงานในขณะนี้' : 'กำลังโหลด หรือดึงข้อมูลไม่สำเร็จ');
  }


  // ---------- ⭐ ที่ของฉัน (บันทึกในเครื่องนี้เท่านั้น) ----------
  const PL_KEY = 'bkkflood.places', PL_ICON = { home: '🏠', work: '🏢', other: '📍' }, PL_NAME = { home: 'บ้าน', work: 'ที่ทำงาน', other: 'ที่ของฉัน' };
  let places = Flood.store.get(PL_KEY) || [], avoidPts = null;
  const savePlaces = () => Flood.store.set(PL_KEY, places);
  layers.places = L.layerGroup().addTo(map);
  getJSON('data/avoid.json', 20000, { cache: 'no-cache' }).then((d) => { avoidPts = d.p || []; renderPlaces(); }).catch(() => { avoidPts = []; });
  // จุดน้ำท่วมทุกแหล่งบนแผนที่: เซ็นเซอร์ที่ท่วม, หน่วยงาน, Traffy, หมุดประชาชน
  const floodPts = () => [
    ...(S.sensor || []).filter((x) => x.lv > 0).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: (x.s.name || x.s.road || 'เซ็นเซอร์ กทม.') + ` ${Math.round(x.cm)} ซม.` })),
    ...(S.event || []).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: String(x.e.title || '').replace(/^น้ำท่วม\s*/, '') })),
    ...(S.traffy || []).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv, name: 'ประชาชนแจ้ง (Traffy)' })),
    ...(S.web || []).map((x) => ({ la: x.la, lo: x.lo, lv: x.lv || 2, name: 'ประชาชนปักหมุด' })),
  ].filter((x) => x.la && x.lo);
  // สถานะรอบที่: น้ำท่วมใน 500 ม. / รายงานใน 1 กม. / ถนนควรระวังมากใน 300 ม. / ปกติ
  function placeStatus(p, pts) {
    let n = null;
    for (const c of pts) { const km = distKm(p.la, p.lo, c.la, c.lo); if (!n || km < n.km || (km <= 0.5 && c.lv > n.c.lv && n.km <= 0.5)) n = { c, km }; }
    const m = (km) => (km < 1 ? Math.round(km * 1000) + ' ม.' : km.toFixed(1) + ' กม.');
    const cnt = pts.filter((c) => distKm(p.la, p.lo, c.la, c.lo) <= 1).length;
    if (n && n.km <= 0.5) return [3, `น้ำท่วมห่าง ${m(n.km)} · ${n.c.name}${cnt > 1 ? ` · ในรัศมี 1 กม. มี ${cnt} จุด` : ''}`];
    if (n && n.km <= 1) return [2, `มีรายงานน้ำท่วมห่าง ${m(n.km)} · ${n.c.name}`];
    if ((avoidPts || []).some(([la, lo, k]) => k === 1 && distKm(p.la, p.lo, la, lo) <= 0.3)) return [1, 'ถนนใกล้ ๆ อยู่ในระดับควรระวังมาก'];
    if (n && n.km <= 3) return [1, `มีน้ำท่วมในรัศมี 3 กม. · ใกล้สุดห่าง ${m(n.km)} · ${n.c.name}`];
    return [0, n ? `ปกติ · จุดน้ำท่วมใกล้สุดห่าง ${m(n.km)}` : 'ปกติ · ไม่มีรายงานน้ำท่วมใกล้ ๆ'];
  }
  function renderPlaces() {
    const el = $('plList');
    layers.places.clearLayers();
    if (!el) return;
    if (!places.length) {
      el.innerHTML = '<p class="small">เพิ่มบ้านหรือที่ทำงาน แล้วทุกครั้งที่เปิดแผนที่จะเห็นทันทีว่ารอบ ๆ มีน้ำท่วมไหม</p>';
      return;
    }
    const pts = floodPts();
    const st = places.map((p) => placeStatus(p, pts));
    el.innerHTML = places.map((p, i) => {
      const [lv, text] = st[i];
      const to = `route.html?to=${p.la.toFixed(5)},${p.lo.toFixed(5)}&name=${encodeURIComponent(p.name)}`;
      return `<div class="pl-row lv${lv}"><span class="pl-ic" aria-hidden="true">${PL_ICON[p.kind] || '📍'}</span>
        <div class="pl-t"><b>${esc(p.name)}</b><span><span class="dot" style="--c:${LEVEL[lv].color}"></span> ${esc(text)}</span></div>
        <div class="pl-act"><a class="btn sm" href="${to}" title="หาเส้นทางเลี่ยงน้ำไปที่นี่">🚗</a><button type="button" class="btn sm" data-map="${i}" title="ดูบนแผนที่">🗺</button><button type="button" class="btn sm" data-del="${i}" title="ลบ" aria-label="ลบ ${esc(p.name)}">✕</button></div></div>`;
    }).join('');
    el.querySelectorAll('[data-map]').forEach((b) => b.onclick = () => { const p = places[+b.dataset.map]; map.setView([p.la, p.lo], 15); p.marker && p.marker.openPopup(); minimizePanel(); });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { if (confirm('ลบ "' + places[+b.dataset.del].name + '" ?')) { places.splice(+b.dataset.del, 1); savePlaces(); renderPlaces(); } });
    // หมุดบนแผนที่: ไอคอนตามประเภท ขอบสีตามสถานะ + วงรัศมี 1 กม.
    places.forEach((p, i) => {
      const [lv, text] = st[i];
      L.circle([p.la, p.lo], { radius: 1000, color: LEVEL[lv].color, weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(layers.places);
      p.marker = L.marker([p.la, p.lo], { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="plm" style="--c:${LEVEL[lv].color}">${PL_ICON[p.kind] || '📍'}</div>` }), zIndexOffset: 2000 })
        .bindPopup(`<div class="pp"><div class="m">⭐ ที่ของฉัน</div><h3>${esc(p.name)}</h3>${badge(lv, lv ? undefined : 'ปกติ')}<div class="m" style="margin-top:4px">${esc(text)}</div>
          <div style="margin-top:6px"><a href="route.html?to=${p.la.toFixed(5)},${p.lo.toFixed(5)}&name=${encodeURIComponent(p.name)}">🚗 หาเส้นทางเลี่ยงน้ำไปที่นี่</a></div></div>`).addTo(layers.places);
    });
  }
  {
    const form = $('plForm'), msg = (t) => { $('plMsg').textContent = t; };
    const kind = () => document.querySelector('input[name="plKind"]:checked').value;
    const add = (la, lo, label) => {
      if (places.length >= 8) { msg('บันทึกได้สูงสุด 8 ที่'); return; }
      const name = $('plName').value.trim() || (kind() === 'other' ? label : PL_NAME[kind()]);
      places.push({ kind: kind(), name: name.slice(0, 40), la: +la.toFixed(5), lo: +lo.toFixed(5) });
      savePlaces(); form.hidden = true; $('plName').value = $('plQ').value = ''; $('plSug').hidden = true; renderPlaces();
    };
    $('plAdd').onclick = () => { form.hidden = !form.hidden; msg(''); if (!form.hidden) $('plQ').focus(); };
    $('plCancel').onclick = () => { form.hidden = true; };
    $('plHere').onclick = () => {
      if (!navigator.geolocation) { msg('เบราว์เซอร์นี้หาตำแหน่งไม่ได้'); return; }
      msg('กำลังหาตำแหน่ง…');
      navigator.geolocation.getCurrentPosition((p) => add(p.coords.latitude, p.coords.longitude, 'ตำแหน่งที่บันทึก'), () => msg('หาตำแหน่งไม่ได้ (ต้องอนุญาตให้เว็บเข้าถึงตำแหน่ง)'), { enableHighAccuracy: true, timeout: 15000 });
    };
    let timer = null;
    $('plQ').addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim(), box = $('plSug');
      if (q.length < 3) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const r = await getJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=th&countrycodes=th&bounded=1&viewbox=100.2,14.1,101.0,13.4&q=' + encodeURIComponent(q), 15000);
          box.innerHTML = r.length ? r.map((x, i) => `<button type="button" data-i="${i}">${esc(x.display_name)}</button>`).join('') : '<p class="muted small" style="padding:8px">ไม่พบสถานที่</p>';
          box.hidden = false;
          box.querySelectorAll('button').forEach((b) => b.onclick = () => { const x = r[+b.dataset.i]; add(+x.lat, +x.lon, x.name || x.display_name.split(',')[0]); });
        } catch (err) { msg('ค้นหาไม่ได้ขณะนี้ ลองใช้ตำแหน่งปัจจุบันแทน'); }
      }, 450);
    });
  }


  // ---------- ความสูงพื้นดิน (DeltaDTM v1.1, 30 ม., ไม่รวมตึก/ต้นไม้) ----------
  // ข้อมูลประกอบเท่านั้น: เทียบกับจุดที่ท่วมจริงแล้วพบว่าจุดท่วมไม่ได้ต่ำกว่ารอบ ๆ (ท่วมเพราะการระบายมากกว่า) จึงไม่ใช้ในการทาย
  let elevMeta = null, elevGrid = null, elevLegend = null;
  async function elevLoad() {
    elevMeta ||= await getJSON('data/elev/bkk-elev.json', 20000);
    return elevMeta;
  }
  layers.elev.on('add', async () => {
    const m = await elevLoad().catch(() => null);
    if (!m) return;
    if (!layers.elev.getLayers().length) L.imageOverlay('data/elev/bkk-elev.png', m.bounds, { opacity: 0.6, interactive: false,
      attribution: 'ความสูงพื้นดิน: <a href="' + m.doi + '" target="_blank" rel="noopener">DeltaDTM v1.1</a> (Pronk et al. 2024, CC BY 4.0)' }).addTo(layers.elev);
    elevLegend = L.control({ position: 'bottomleft' });
    elevLegend.onAdd = () => {
      const d = L.DomUtil.create('div', 'elev-lg');
      d.innerHTML = '<b>ความสูงพื้นดิน (ม. เหนือระดับน้ำทะเล)</b><div class="elev-bar"></div><div class="elev-ticks"><span>0.5</span><span>1.0</span><span>1.75</span><span>2.5</span><span>3+</span></div>'
        + '<div class="m">กดบนแผนที่เพื่อดูค่า · คลาดเคลื่อนได้ราว ±0.45 ม. · ใช้ประกอบเท่านั้น</div>';
      return d;
    };
    elevLegend.addTo(map);
  });
  layers.elev.on('remove', () => { if (elevLegend) { elevLegend.remove(); elevLegend = null; } });
  map.on('click', async (e) => {
    if (!map.hasLayer(layers.elev) || map.getContainer().classList.contains('picking') || map.getContainer().classList.contains('closing')) return;
    const m = await elevLoad().catch(() => null);
    if (!m) return;
    if (!elevGrid) {
      const r = await fetch('data/elev/bkk-elev-60m.u8').catch(() => null);
      if (!r || !r.ok) return;
      elevGrid = new Uint8Array(await r.arrayBuffer());
    }
    const row = Math.floor((e.latlng.lat - m.lat0) / m.dlat), col = Math.floor((e.latlng.lng - m.lon0) / m.dlon);
    const v = row >= 0 && row < m.rows && col >= 0 && col < m.cols ? elevGrid[row * m.cols + col] : 255;
    const h = v === 255 ? null : v * 0.02 - 1.0;
    const diff = h == null ? 0 : Math.round((h - m.median_bkk) * 100);
    L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(h == null
      ? '<div class="pp"><div class="m">ความสูงพื้นดิน</div>ไม่มีข้อมูลตรงนี้ (แหล่งน้ำ หรือนอกพื้นที่)</div>'
      : `<div class="pp"><div class="m">ความสูงพื้นดิน (DeltaDTM)</div><span class="big">${h.toFixed(2)}</span> ม. เหนือระดับน้ำทะเล
        <div class="m" style="margin-top:4px">${Math.abs(diff) < 10 ? 'ใกล้เคียงค่ากลางของ กทม.' : diff < 0 ? `ต่ำกว่าค่ากลาง กทม. ${-diff} ซม.` : `สูงกว่าค่ากลาง กทม. ${diff} ซม.`} (ค่ากลาง ${m.median_bkk} ม.)<br>
        ค่าเฉลี่ยช่อง 60 ม. · คลาดเคลื่อนได้ราว ±0.45 ม. · น้ำท่วมใน กทม. ขึ้นกับท่อ/การระบายมากกว่าความสูงพื้นที่</div></div>`).openOn(map);
  });

  // ---------- UI ----------
  const panel = $('panel');
  // มือถือ: แผง 3 ระดับ ย่อ (min) → ปกติ → เต็มจอ (full) กดที่แถบจับหรือปัดขึ้น/ลง
  const STATES = ['min', '', 'full'];
  const stateNow = () => (panel.classList.contains('full') ? 2 : panel.classList.contains('min') ? 0 : 1);
  function setPanel(i) {
    i = Math.max(0, Math.min(2, i));
    panel.classList.toggle('min', i === 0); panel.classList.toggle('full', i === 2);
    $('grab').setAttribute('aria-label', i === 2 ? 'ย่อแผง' : 'ขยายแผง');
    if (i !== 2) setTimeout(() => map.invalidateSize(), 250);
  }
  function minimizePanel() { if (isMobile) setPanel(0); }
  $('grab').onclick = () => setPanel(stateNow() === 2 ? 1 : stateNow() + 1);
  let touchY = null;
  const head = panel.querySelector('.tabs');
  [$('grab'), head].forEach((el) => {
    el.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (touchY == null) return;
      const dy = e.changedTouches[0].clientY - touchY; touchY = null;
      if (Math.abs(dy) > 40) setPanel(stateNow() + (dy < 0 ? 1 : -1));
    }, { passive: true });
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    // แท็บที่ต้องอ่านเยอะ (ข่าว Facebook แหล่งข้อมูล) เปิดเต็มจอบนมือถือ แท็บอื่นเปิดครึ่งจอ
    if (isMobile) setPanel(['news', 'fb', 'src', 'cam'].includes(b.dataset.tab) ? 2 : Math.max(1, stateNow()));
    else panel.classList.remove('min');
    if (b.dataset.tab === 'fb') openFacebook();
  });
  document.querySelectorAll('.kpi').forEach((k) => k.onclick = () => {
    const l = layers[k.dataset.layer];
    if (l && !map.hasLayer(l)) map.addLayer(l);
    if (k.dataset.layer === 'news') document.querySelector('.tabs [data-tab="news"]').click();
    else { const pts = l ? l.getLayers().filter((m) => m.getLatLng) : []; if (pts.length) map.fitBounds(L.latLngBounds(pts.map((m) => m.getLatLng())).pad(0.1), { maxZoom: 14 }); }
  });

  let last = 0;
  function refresh() {
    last = Date.now();
    $('updated').textContent = 'กำลังอัปเดต…';
    Promise.allSettled([loadSensors().then(loadTrends), loadEvents(), loadTraffy(), loadRain(), loadWl(), loadRelay(), loadTw(), loadNews(), loadTmd(), loadRadar(), S.cam ? null : loadCams()])
      .then(() => { $('updated').textContent = `อัปเดตหน้าเว็บ ${fmtTime(new Date(last))} · รีเฟรชอัตโนมัติทุก 15 นาที`; renderCams(); });
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > REFRESH_MS) refresh(); });
  setInterval(refresh, REFRESH_MS);
  loadDistricts();
  renderPlaces();
  // ลิงก์ map.html#places เปิดแท็บที่ของฉัน
  if (location.hash === '#places') { const t = document.querySelector('.tabs [data-tab="pl"]'); if (t) t.click(); }
  // ลิงก์ map.html#report จากหน้าแรก: เปิดโหมดแจ้งน้ำท่วมทันที
  if (location.hash === '#report') setTimeout(() => { const b = [...document.querySelectorAll('button')].find((x) => /แจ้งน้ำท่วม/.test(x.textContent)); if (b) b.click(); }, 600);
  refresh();
  // ให้ js/report.js (ระบบปักหมุดแจ้งน้ำท่วม) ใช้แผนที่และชั้นข้อมูลเดียวกัน
  window.FloodMap = { map, layers, setFeed, icon, minimizePanel, isMobile };
})();
