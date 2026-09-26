/* แผนที่สถานการณ์น้ำท่วม กทม.
 * - ข้อมูลเรียลไทม์ (เซ็นเซอร์ กทม., ThaiWater, iTIC/Longdo, Traffy, กล้อง) ดึงจากเบราว์เซอร์ของผู้ชมโดยตรง
 *   เพราะบางแหล่ง (เช่น floodbangkok.bangkok.go.th) เปิดให้เฉพาะ IP ในประเทศไทย
 * - ข่าว + สรุป AI + ประกาศกรมอุตุฯ อ่านจาก data/*.json ที่ GitHub Actions สร้างทุก 15 นาที
 */
(function () {
  'use strict';

  const REFRESH_MS = 15 * 60 * 1000;
  const TZ = 'Asia/Bangkok';
  const BBOX = { s: 13.48, n: 13.97, w: 100.32, e: 100.95 }; // กรอบ กทม.
  const TRAFFY_WINDOW_H = 24;
  const SENSOR_STALE_H = 3;
  const WL_STALE_H = 6;
  const CAM_NEAR_KM = 1.5;
  const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
  const BMA = 'https://floodbangkok.bangkok.go.th/bkk/dds/services/api/floods/v1/items/';
  const URL = {
    sensors: BMA + 'sensor_profile?limit=-1',
    notif: BMA + 'flood_notification?limit=1500&page=0&sort=-date_created&fields=sensor_profile,value,date_created',
    events: 'https://event.longdo.com/feed/json',
    traffy: 'https://publicapi.traffy.in.th/share/teamchadchart/search?limit=1000',
    rain: TW + 'rain_24h',
    wl: TW + 'waterlevel_load',
    cams: 'https://camera.longdo.com/feed/?command=json',
    radar: 'https://api.rainviewer.com/public/weather-maps.json',
    news: 'data/news.json',
    tmd: 'data/tmd.json',
    meta: 'data/meta.json',
    districts: 'data/districts.geojson',
  };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const inBkk = (la, lo) => la >= BBOX.s && la <= BBOX.n && lo >= BBOX.w && lo <= BBOX.e;
  const th = (o) => (o && typeof o === 'object' ? o.th || o.en || '' : o || '');
  const fmt = (d, opt) => (d ? new Intl.DateTimeFormat('th-TH', { timeZone: TZ, ...opt }).format(d) : '–');
  const fmtTime = (d) => fmt(d, { hour: '2-digit', minute: '2-digit' }) + ' น.';
  const fmtDT = (d) => fmt(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' น.';
  const ago = (d) => {
    if (!d) return '';
    const m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return 'เมื่อสักครู่';
    if (m < 60) return m + ' นาทีที่แล้ว';
    const h = Math.floor(m / 60);
    return h < 48 ? h + ' ชม.ที่แล้ว' : Math.floor(h / 24) + ' วันที่แล้ว';
  };
  // เวลาแบบ "2026-09-26 21:30" ของ ThaiWater/Longdo เป็นเวลาไทย
  const bkkDate = (s) => {
    const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
    if (!m) return null;
    const d = new Date(`${m[1]}T${m[2]}${m[3] || ':00'}+07:00`);
    return isNaN(d) ? null : d;
  };
  const isoDate = (s) => { if (!s) return null; const d = new Date(String(s).replace(' ', 'T').replace(/\+00$/, 'Z')); return isNaN(d) ? null : d; };
  function distKm(a, b, c, d) {
    const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  }
  async function getJSON(url, ms = 45000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : e.message || 'เชื่อมต่อไม่ได้');
    } finally { clearTimeout(t); }
  }

  // ---------- ระดับความรุนแรง (สีต้องมาพร้อมข้อความเสมอ) ----------
  const LEVEL = {
    0: { key: 'good', label: 'ปกติ', color: 'var(--good)' },
    1: { key: 'warning', label: 'เล็กน้อย', color: 'var(--warning)', dark: true },
    2: { key: 'serious', label: 'ท่วม', color: 'var(--serious)', dark: true },
    3: { key: 'critical', label: 'ท่วมสูง', color: 'var(--critical)' },
  };
  const badge = (lv, text) => `<span class="badge${LEVEL[lv].dark ? ' dark' : ''}" style="--c:${LEVEL[lv].color}">${esc(text || LEVEL[lv].label)}</span>`;
  const sensorLevel = (cm) => (cm >= 15 ? 3 : cm >= 10 ? 2 : cm >= 5 ? 1 : 0);
  const wlLevel = (pct) => (pct >= 100 ? 3 : pct >= 90 ? 2 : pct >= 70 ? 1 : 0);
  const RAIN_STEPS = [[90, 'var(--rain4)', 'หนักมาก'], [35, 'var(--rain3)', 'หนัก'], [10, 'var(--rain2)', 'ปานกลาง'], [0.1, 'var(--rain1)', 'เล็กน้อย'], [-1, 'var(--rain0)', 'ไม่มีฝน']];
  const rainStep = (mm) => RAIN_STEPS.find((s) => mm > s[0]) || RAIN_STEPS[RAIN_STEPS.length - 1];

  // ประเมินความรุนแรงจากข้อความรายงาน (iTIC / Traffy)
  function levelFromText(text) {
    const t = String(text || '');
    let cm = null;
    for (const m of t.matchAll(/(\d{1,3})(?:\s*[-–~]\s*(\d{1,3}))?\s*(?:ซ\.?\s?ม\.?|ซม|เซน(?:ติเมตร)?|cm)/gi)) {
      const v = Math.max(+m[1], m[2] ? +m[2] : 0);
      if (v > 0 && v < 300) cm = Math.max(cm || 0, v);
    }
    if (/น้ำลด(ลง)?แล้ว|ระบายแล้ว|แห้งแล้ว|กลับสู่ภาวะปกติ|ผ่านได้ตามปกติ/.test(t)) return { lv: 0, why: 'รายงานว่าน้ำลดแล้ว' };
    if (/ผ่านไม่ได้|ไม่สามารถผ่าน|สัญจรไม่ได้|ปิดการจราจร|ปิดถนน/.test(t)) return { lv: 3, why: 'รายงานว่ารถผ่านไม่ได้' + (cm ? ` · ${cm} ซม.` : '') };
    if (cm != null) return { lv: cm >= 20 ? 3 : cm >= 10 ? 2 : 1, why: `ระดับน้ำประมาณ ${cm} ซม.` };
    if (/เข่า|เอว|ต้นขา|หน้าแข้ง/.test(t)) return { lv: 3, why: 'รายงานว่าน้ำสูงระดับเข่าขึ้นไป' };
    if (/ข้อเท้า|ตาตุ่ม/.test(t)) return { lv: 1, why: 'รายงานว่าน้ำสูงระดับข้อเท้า' };
    return { lv: 2, why: 'มีรายงานน้ำท่วม ไม่ระบุความสูง' };
  }

  // ---------- แผนที่ ----------
  const isMobile = matchMedia('(max-width: 860px)').matches;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  const map = L.map('map', { zoomControl: !isMobile, minZoom: 9, maxZoom: 18, preferCanvas: false }).setView(isMobile ? [13.66, 100.58] : [13.76, 100.55], isMobile ? 10 : 11);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'rastertiles/voyager'}/{z}/{x}/{y}{r}.png`, {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  const layers = {
    districts: L.layerGroup().addTo(map),
    radar: L.layerGroup(),
    rain: L.layerGroup().addTo(map),
    wl: L.layerGroup().addTo(map),
    news: L.layerGroup().addTo(map),
    traffy: L.layerGroup().addTo(map),
    event: L.layerGroup().addTo(map),
    sensor: L.layerGroup().addTo(map),
    cam: L.layerGroup(),
  };
  L.control.layers(null, {
    'เซ็นเซอร์น้ำท่วมถนน กทม.': layers.sensor,
    'รายงานน้ำท่วม (หน่วยงาน/iTIC)': layers.event,
    'ประชาชนแจ้ง (Traffy 24 ชม.)': layers.traffy,
    'ตำแหน่งจากข่าว / YouTube': layers.news,
    'ระดับน้ำคลอง/แม่น้ำ': layers.wl,
    'ปริมาณฝน 24 ชม.': layers.rain,
    'เรดาร์ฝน (RainViewer)': layers.radar,
    'กล้อง CCTV สาธารณะ': layers.cam,
    'ขอบเขตเขต': layers.districts,
  }, { collapsed: true, position: 'topright' }).addTo(map);

  const icon = (cls, color, text = '', size = 18, extra = '') =>
    L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
      html: `<div class="mk ${cls} ${extra}" style="--c:${color};width:${size}px;height:${size}px">${text}</div>`,
    });

  // ---------- สถานะแหล่งข้อมูล ----------
  const FEEDS = {
    sensor: { name: 'เซ็นเซอร์น้ำท่วมถนน – สำนักการระบายน้ำ กทม.', link: 'https://weather.bangkok.go.th/flood/', note: 'เปิดได้เฉพาะเครือข่ายในประเทศไทย' },
    event: { name: 'รายงานน้ำท่วมถนน – iTIC / Longdo Traffic (กทม., ทล., ผู้ใช้)', link: 'https://traffic.longdo.com' },
    traffy: { name: 'เรื่องแจ้งจากประชาชน – Traffy Fondue', link: 'https://fondue.traffy.in.th/teamchadchart' },
    wl: { name: 'ระดับน้ำ – ThaiWater (สสน.)', link: 'https://www.thaiwater.net' },
    rain: { name: 'ปริมาณฝน – ThaiWater (สสน.)', link: 'https://www.thaiwater.net' },
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
        : st === 'loading' ? 'กำลังโหลด…' : 'ใช้งานไม่ได้ขณะนี้ – ' + esc(f.msg || '');
      return `<div class="feed ${st}"><span class="st"></span><div><a href="${f.link}" target="_blank" rel="noopener">${esc(f.name)}</a><div class="fs">${s}${f.note ? ' · ' + esc(f.note) : ''}</div></div></div>`;
    }).join('');
    const failed = Object.entries(FEEDS).filter(([k, f]) => f.status === 'fail' && k !== 'radar' && k !== 'cam').map(([, f]) => f);
    $('warn').hidden = !failed.length;
    $('warn').textContent = failed.length ? `ดึงข้อมูลไม่สำเร็จ ${failed.length} แหล่ง (${failed.map((f) => f.name.split(' – ')[0]).join(', ')}) ตัวเลขอาจไม่ครบ – ดูแท็บ "แหล่งข้อมูล"` : '';
  }

  const S = {};

  // ---------- 1) เซ็นเซอร์น้ำท่วมถนน กทม. ----------
  async function loadSensors() {
    setFeed('sensor', 'loading');
    try {
      const [sp, nt] = await Promise.all([getJSON(URL.sensors), getJSON(URL.notif)]);
      const latest = new Map();
      for (const n of nt.data || []) if (!latest.has(n.sensor_profile)) latest.set(n.sensor_profile, n);
      let newest = null;
      S.sensor = (sp.data || [])
        .filter((s) => String(s.code || '').startsWith('FL.') && num(s.lat) && num(s.long))
        .map((s) => {
          const n = latest.get(s.id);
          const t = n ? isoDate(n.date_created) : null;
          const cm = n ? num(n.value) : null;
          if (t && (!newest || t > newest)) newest = t;
          const stale = !t || Date.now() - t > SENSOR_STALE_H * 36e5;
          return { s, la: num(s.lat), lo: num(s.long), cm, t, stale, lv: stale || cm == null ? 0 : sensorLevel(cm) };
        });
      setFeed('sensor', 'ok', `${S.sensor.length} จุด`, newest);
    } catch (e) { S.sensor = null; setFeed('sensor', 'fail', e.message); }
    drawSensors();
  }
  function drawSensors() {
    layers.sensor.clearLayers();
    if (!S.sensor) { $('kSensor').textContent = '–'; return; }
    for (const x of S.sensor) {
      const flooded = x.lv > 0;
      const size = flooded ? 26 : 12;
      const html = `<div class="pp"><div class="m">เซ็นเซอร์น้ำท่วมถนน กทม. · ${esc(x.s.code)}</div>
        <h3>${esc(x.s.name || x.s.road || '')}</h3>
        ${x.stale ? '<span class="badge" style="--c:var(--stale)">ไม่มีค่าล่าสุด</span>' : badge(x.lv)}
        <div style="margin-top:4px"><span class="big">${x.cm != null && !x.stale ? x.cm : '–'}</span> ซม.</div>
        <div class="m">${esc(x.s.road || '')} ${x.s.district ? '· ' + esc(x.s.district) : ''}<br>
        อ่านค่า ${x.t ? fmtDT(x.t) + ' (' + ago(x.t) + ')' : '–'}</div></div>`;
      x.marker = L.marker([x.la, x.lo], {
        icon: icon('sensor', LEVEL[x.lv].color, flooded ? Math.round(x.cm) : '', size, (LEVEL[x.lv].dark ? 'dark' : '') + (x.stale ? ' stale' : '')),
        zIndexOffset: flooded ? 1000 + x.cm : 0, opacity: flooded ? 1 : 0.75,
      }).bindPopup(html).addTo(layers.sensor);
    }
    $('kSensor').textContent = S.sensor.filter((x) => x.lv > 0).length;
    renderFloodList();
  }

  // ---------- 2) รายงานน้ำท่วมจากหน่วยงาน / iTIC ----------
  async function loadEvents() {
    setFeed('event', 'loading');
    try {
      const d = await getJSON(URL.events);
      if (!Array.isArray(d)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      const now = Date.now();
      let newest = null;
      S.event = d.filter((e) => String(e.type) === '6' || e.icon === 'flood')
        .map((e) => ({ e, la: num(e.latitude), lo: num(e.longitude), start: bkkDate(e.start), stop: bkkDate(e.stop), ...levelFromText(`${e.title} ${e.description}`) }))
        .filter((x) => x.la && x.lo && inBkk(x.la, x.lo) && (!x.stop || x.stop >= now) && (!x.start || x.start <= now + 36e5) && x.lv > 0);
      S.event.forEach((x) => { if (x.start && (!newest || x.start > newest)) newest = x.start; });
      setFeed('event', 'ok', `${S.event.length} จุดที่ยังมีผล`, newest);
    } catch (e) { S.event = null; setFeed('event', 'fail', e.message); }
    drawEvents();
  }
  function drawEvents() {
    layers.event.clearLayers();
    if (!S.event) { $('kEvent').textContent = '–'; return; }
    for (const x of S.event) {
      const e = x.e;
      const html = `<div class="pp">${badge(x.lv)} <span class="m">รายงานจาก ${esc(e.contributor || 'iTIC / Longdo')}</span>
        <h3>${esc(e.title)}</h3><div>${esc(e.description || '').slice(0, 500)}</div>
        <div class="m" style="margin-top:6px">${esc(x.why)}<br>เริ่ม ${fmtDT(x.start)}${x.stop ? ' · ถึง ' + fmtDT(x.stop) : ''}</div></div>`;
      x.marker = L.marker([x.la, x.lo], { icon: icon('event', LEVEL[x.lv].color, '', 20, LEVEL[x.lv].dark ? 'dark' : ''), zIndexOffset: 800 }).bindPopup(html, { maxWidth: 320 }).addTo(layers.event);
    }
    $('kEvent').textContent = S.event.length;
    renderFloodList(); renderCams();
  }

  // ---------- 3) Traffy Fondue ----------
  const FLOOD_RE = /ท่วม|น้ำขัง|น้ำรอระบาย|รอการระบาย/;
  async function loadTraffy() {
    setFeed('traffy', 'loading');
    try {
      const d = await getJSON(URL.traffy, 60000);
      if (!Array.isArray(d.results)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      const cutoff = Date.now() - TRAFFY_WINDOW_H * 36e5;
      let newest = null;
      S.traffy = d.results
        .map((r) => ({ r, t: isoDate(r.timestamp), lo: num(r.coords && r.coords[0]), la: num(r.coords && r.coords[1]) }))
        .filter((x) => x.la && x.lo && x.t && x.t >= cutoff && inBkk(x.la, x.lo) && x.r.state !== 'เสร็จสิ้น'
          && (/น้ำท่วม/.test(String(x.r.type || '')) || FLOOD_RE.test(x.r.description || '')))
        .map((x) => ({ ...x, ...levelFromText(x.r.description) }))
        .filter((x) => x.lv > 0);
      S.traffy.forEach((x) => { if (!newest || x.t > newest) newest = x.t; });
      setFeed('traffy', 'ok', `${S.traffy.length} เรื่องใน ${TRAFFY_WINDOW_H} ชม.`, newest);
    } catch (e) { S.traffy = null; setFeed('traffy', 'fail', e.message); }
    drawTraffy();
  }
  function drawTraffy() {
    layers.traffy.clearLayers();
    if (!S.traffy) { $('kTraffy').textContent = '–'; return; }
    for (const x of S.traffy) {
      const r = x.r;
      const html = `<div class="pp">${badge(x.lv)} <span class="m">ประชาชนแจ้ง · ยังไม่ยืนยัน</span>
        <div style="margin-top:6px">${esc((r.description || '').slice(0, 320))}</div>
        ${r.photo_url ? `<img loading="lazy" src="${esc(r.photo_url)}" alt="ภาพจากผู้แจ้ง" referrerpolicy="no-referrer">` : ''}
        <div class="m" style="margin-top:6px">${esc(r.address || '')}<br>แจ้งเมื่อ ${fmtDT(x.t)} (${ago(x.t)}) · สถานะ: ${esc(r.state || '')}<br>
        <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.ticket_id)}" target="_blank" rel="noopener">ดูเรื่อง ${esc(r.ticket_id)}</a></div></div>`;
      x.marker = L.marker([x.la, x.lo], { icon: icon('traffy', LEVEL[x.lv].color, '', 16), zIndexOffset: 400 }).bindPopup(html, { maxWidth: 300 }).addTo(layers.traffy);
    }
    $('kTraffy').textContent = S.traffy.length;
    renderFloodList(); renderCams();
  }

  // ---------- 4) ThaiWater ฝน ----------
  async function loadRain() {
    setFeed('rain', 'loading');
    try {
      const d = await getJSON(URL.rain, 120000);
      if (!Array.isArray(d.data)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      const cutoff = Date.now() - 30 * 36e5;
      let newest = null;
      S.rain = d.data.filter((x) => x.geocode && String(x.geocode.province_code) === '10')
        .map((x) => ({ x, t: bkkDate(x.rainfall_datetime), la: num(x.station && x.station.tele_station_lat), lo: num(x.station && x.station.tele_station_long), mm: num(x.rain_24h), mm1: num(x.rain_1h) }))
        .filter((s) => s.la && s.lo && s.t && s.t >= cutoff && s.mm != null);
      S.rain.forEach((s) => { if (!newest || s.t > newest) newest = s.t; });
      setFeed('rain', 'ok', `${S.rain.length} สถานี`, newest);
    } catch (e) { S.rain = null; setFeed('rain', 'fail', e.message); }
    drawRain();
  }
  function drawRain() {
    layers.rain.clearLayers();
    if (!S.rain) { $('kRain').textContent = '–'; $('listRain').innerHTML = '<div class="muted small">ไม่มีข้อมูลฝน</div>'; return; }
    for (const s of S.rain) {
      const st = rainStep(s.mm);
      const html = `<div class="pp"><div class="m">สถานีวัดฝน · ${esc(th(s.x.agency && s.x.agency.agency_shortname))}</div><h3>${esc(th(s.x.station.tele_station_name))}</h3>
        <div><span class="big">${s.mm}</span> มม. / 24 ชม. (${st[2]})${s.mm1 != null ? ` · ${s.mm1} มม. ชั่วโมงล่าสุด` : ''}</div>
        <div class="m">เขต${esc(th(s.x.geocode.amphoe_name))} · ${fmtDT(s.t)} (${ago(s.t)})</div></div>`;
      s.marker = L.circleMarker([s.la, s.lo], { radius: s.mm > 35 ? 8 : 6, color: '#fff', weight: 1.5, fillColor: getComputedStyle(document.documentElement).getPropertyValue(st[1].slice(4, -1)).trim(), fillOpacity: 0.95 }).bindPopup(html).addTo(layers.rain);
    }
    const top = [...S.rain].sort((a, b) => b.mm - a.mm);
    $('kRain').textContent = top.length ? top[0].mm.toFixed(0) : '–';
    $('kRainAt').textContent = top.length ? 'มม. · ' + th(top[0].x.station.tele_station_name) : 'มม.';
    listInto('listRain', top.filter((s) => s.mm > 0).slice(0, 6), (s) => ({
      dot: rainStep(s.mm)[1], title: th(s.x.station.tele_station_name), sub: `เขต${th(s.x.geocode.amphoe_name)} · ${fmtTime(s.t)}`, right: s.mm + ' มม.', go: s,
    }), 'ไม่มีฝนใน 24 ชม. ที่ผ่านมา');
  }

  // ---------- 5) ThaiWater ระดับน้ำ ----------
  async function loadWl() {
    setFeed('wl', 'loading');
    try {
      const d = await getJSON(URL.wl, 120000);
      const arr = d && d.waterlevel_data && d.waterlevel_data.data;
      if (!Array.isArray(arr)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      let newest = null;
      S.wl = arr.filter((x) => x.geocode && String(x.geocode.province_code) === '10')
        .map((x) => ({ x, t: bkkDate(x.waterlevel_datetime), la: num(x.station && x.station.tele_station_lat), lo: num(x.station && x.station.tele_station_long), pct: num(x.storage_percent), msl: num(x.waterlevel_msl), prev: num(x.waterlevel_msl_previous), bank: num(x.station && x.station.min_bank) }))
        .filter((s) => s.la && s.lo && s.t)
        .map((s) => ({ ...s, stale: Date.now() - s.t > WL_STALE_H * 36e5 }));
      S.wl.forEach((s) => { if (!newest || s.t > newest) newest = s.t; });
      setFeed('wl', 'ok', `${S.wl.length} สถานี`, newest);
    } catch (e) { S.wl = null; setFeed('wl', 'fail', e.message); }
    drawWl();
  }
  function trend(s) {
    if (s.msl == null || s.prev == null) return '';
    const d = s.msl - s.prev;
    return Math.abs(d) < 0.005 ? 'ทรงตัว' : d > 0 ? `▲ ขึ้น ${d.toFixed(2)} ม.` : `▼ ลง ${(-d).toFixed(2)} ม.`;
  }
  function drawWl() {
    layers.wl.clearLayers();
    if (!S.wl) { $('listWl').innerHTML = '<div class="muted small">ไม่มีข้อมูลระดับน้ำ</div>'; return; }
    for (const s of S.wl) {
      const lv = s.pct != null ? wlLevel(s.pct) : 0;
      const html = `<div class="pp"><div class="m">สถานีวัดระดับน้ำ · ${esc(th(s.x.agency && s.x.agency.agency_shortname))}</div><h3>${esc(th(s.x.station.tele_station_name))}</h3>
        ${s.pct != null ? badge(lv, `${s.pct.toFixed(0)}% ของตลิ่ง`) : ''} ${s.stale ? '<span class="badge" style="--c:var(--stale)">ค่าเก่า</span>' : ''}
        <div style="margin-top:4px"><span class="big">${s.msl != null ? s.msl.toFixed(2) : '–'}</span> ม.รทก. <span class="m">${trend(s)}</span></div>
        <div class="m">ตลิ่งต่ำสุด ${s.bank != null ? s.bank.toFixed(2) + ' ม.รทก.' : '–'} · เขต${esc(th(s.x.geocode.amphoe_name))}<br>${fmtDT(s.t)} (${ago(s.t)})</div></div>`;
      s.marker = L.marker([s.la, s.lo], { icon: icon('wl', LEVEL[lv].color, '', 14, s.stale ? 'stale' : ''), zIndexOffset: 200 }).bindPopup(html).addTo(layers.wl);
    }
    const hi = S.wl.filter((s) => !s.stale && s.pct != null).sort((a, b) => b.pct - a.pct).slice(0, 6);
    listInto('listWl', hi, (s) => ({ dot: LEVEL[wlLevel(s.pct)].color, title: th(s.x.station.tele_station_name), sub: `${trend(s) || 'ไม่มีแนวโน้ม'} · ${fmtTime(s.t)}`, right: s.pct.toFixed(0) + '%', go: s }), 'ไม่มีสถานีที่มีค่าล่าสุด');
  }

  // ---------- 6) ข่าว + สรุป AI (จาก GitHub Actions) ----------
  const SEV_LV = { 'สูง': 3, 'กลาง': 2, 'ต่ำ': 1 };
  let newsFilter = 'all';
  const isYt = (n) => n.kind === 'youtube';
  const ytThumb = (n) => /^https:\/\/i\.ytimg\.com\//.test(n.thumb || '') ? n.thumb : '';
  async function loadNews() {
    setFeed('news', 'loading'); setFeed('youtube', 'loading');
    try {
      const [d, meta] = await Promise.all([getJSON(URL.news + '?t=' + Date.now()), getJSON(URL.meta + '?t=' + Date.now()).catch(() => null)]);
      S.news = d.items || [];
      const src = (meta && meta.sources) || {};
      const ai = src.news && src.news.ai;
      $('newsNote').textContent = `ข่าวและคลิปเกี่ยวกับน้ำท่วมใน กทม. ช่วง 48 ชม. อัปเดตล่าสุด ${fmtDT(new Date(d.updated))}` +
        (ai === 'ok' ? ' · สรุปและระบุตำแหน่งโดย AI (Gemini) อาจคลาดเคลื่อน โปรดดูต้นฉบับ' : ' · ยังไม่ได้เปิดใช้สรุปด้วย AI (แสดงเฉพาะหัวข้อ และปักหมุดระดับเขต)');
      const nNews = S.news.filter((n) => !isYt(n)).length, nYt = S.news.length - nNews;
      if (src.news && src.news.ok === false) setFeed('news', 'fail', src.news.error || 'ดึงข่าวไม่สำเร็จ');
      else setFeed('news', 'ok', `${nNews} ข่าว`, new Date(d.updated));
      const yt = src.youtube;
      if (!yt || yt.status === 'no-key') setFeed('youtube', 'fail', 'ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY');
      else if (!yt.ok) setFeed('youtube', 'fail', yt.status || yt.error || 'ค้นไม่สำเร็จ');
      else setFeed('youtube', 'ok', `${nYt} คลิป`, new Date(d.updated));
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
        return L.marker([p.lat, p.lng], { icon: icon('news', isYt(n) ? 'var(--yt)' : 'var(--news)', isYt(n) ? '▶' : '', p.precision === 'district' ? 16 : 20, isYt(n) ? 'yt' : ''), zIndexOffset: 300 })
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

  // ---------- 7) ประกาศกรมอุตุฯ ----------
  async function loadTmd() {
    setFeed('tmd', 'loading');
    try {
      const d = await getJSON(URL.tmd + '?t=' + Date.now());
      const items = (d.items || []).slice(0, 2);
      $('tmd').innerHTML = items.map((x) => `<div class="tmd" tabindex="0"><h3>⚠ ${esc(x.title)}</h3><p>${esc(x.description)}</p>
        <div class="muted small">กรมอุตุนิยมวิทยา · ${esc(x.announced)}${x.file ? ` · <a href="${esc(x.file)}" target="_blank" rel="noopener">เอกสาร</a>` : ''}</div></div>`).join('');
      $('tmd').querySelectorAll('.tmd').forEach((el) => el.onclick = () => el.classList.toggle('open'));
      setFeed('tmd', 'ok', `${(d.items || []).length} ประกาศ`, new Date(d.updated));
    } catch (e) { $('tmd').innerHTML = ''; setFeed('tmd', 'fail', 'ยังไม่มีไฟล์ประกาศ (' + e.message + ')'); }
  }

  // ---------- 8) กล้อง CCTV สาธารณะ ----------
  async function loadCams() {
    setFeed('cam', 'loading');
    try {
      const d = await getJSON(URL.cams);
      if (!Array.isArray(d)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      // เฉพาะกล้องที่เผยแพร่สาธารณะผ่าน HTTPS และยังไม่ถูกระงับ
      S.cam = d.map((c) => ({ c, la: num(c.latitude), lo: num(c.longitude) }))
        .filter((x) => x.la && x.lo && inBkk(x.la, x.lo) && /^https:\/\//.test(x.c.hls_url || '') && !/tempsus/.test(x.c.hls_url));
      setFeed('cam', 'ok', `${S.cam.length} กล้อง`);
    } catch (e) { S.cam = null; setFeed('cam', 'fail', e.message); }
    drawCams();
  }
  let hls = null;
  function stopStream() { if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; } }
  function startStream(el, x) {
    stopStream();
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
      x.marker = L.marker([x.la, x.lo], { icon: icon('cam', '#1d2330', '▶', 18), zIndexOffset: -100 })
        .bindPopup(() => `<div class="pp" style="width:290px;max-width:100%"><div class="m">${esc(x.c.organization || '')} · ${esc(x.c.camid)}</div><h3>${esc(x.c.title)}</h3>
          <video muted autoplay playsinline controls></video><div class="m camst">กำลังเชื่อมต่อ…</div>
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
      'ไม่มีกล้องสาธารณะใกล้จุดน้ำท่วมในขณะนี้ (เปิดชั้น "กล้อง CCTV สาธารณะ" ที่มุมขวาบนของแผนที่เพื่อดูทั้งหมด)');
  }

  // ---------- 9) เรดาร์ฝน ----------
  async function loadRadar() {
    setFeed('radar', 'loading');
    try {
      const d = await getJSON(URL.radar, 20000);
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
      const g = await getJSON(URL.districts);
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
    listInto('listFlood', all.slice(0, 15), (r) => r, S.sensor || S.event ? 'ยังไม่มีรายงานถนนน้ำท่วมจากเซ็นเซอร์และหน่วยงานในขณะนี้' : 'กำลังโหลด หรือดึงข้อมูลไม่สำเร็จ');
  }

  // ---------- UI ----------
  const panel = $('panel');
  function minimizePanel() { if (isMobile) panel.classList.add('min'); }
  $('grab').onclick = () => panel.classList.toggle('min');
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    panel.classList.remove('min');
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
    Promise.allSettled([loadSensors(), loadEvents(), loadTraffy(), loadRain(), loadWl(), loadNews(), loadTmd(), loadRadar(), S.cam ? null : loadCams()])
      .then(() => { $('updated').textContent = `อัปเดตหน้าเว็บ ${fmtTime(new Date(last))} · รีเฟรชอัตโนมัติทุก 15 นาที`; renderCams(); });
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > REFRESH_MS) refresh(); });
  setInterval(refresh, REFRESH_MS);
  loadDistricts();
  refresh();
})();
