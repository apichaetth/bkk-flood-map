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
  const map = L.map('map', { zoomControl: !isMobile, minZoom: 9, maxZoom: 18, preferCanvas: false }).setView(isMobile ? [13.66, 100.58] : [13.76, 100.55], isMobile ? 10 : 11);
  // แผนที่ฐาน OpenStreetMap (ฟรี ไม่ต้องใช้ key) โหมดมืดใช้ CSS filter ใน style.css
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

  const layers = {
    districts: L.layerGroup().addTo(map),
    radar: L.layerGroup().addTo(map),
    rain: L.layerGroup().addTo(map),
    wl: L.layerGroup().addTo(map),
    news: L.layerGroup().addTo(map),
    traffy: L.layerGroup().addTo(map),
    event: L.layerGroup().addTo(map),
    sensor: L.layerGroup().addTo(map),
    cam: L.layerGroup().addTo(map),
    web: L.layerGroup().addTo(map),
  };
  L.control.layers(null, {
    'เซ็นเซอร์น้ำท่วมถนน กทม.': layers.sensor,
    'รายงานน้ำท่วม (หน่วยงาน/iTIC)': layers.event,
    'ประชาชนแจ้งผ่านเว็บนี้': layers.web,
    'ประชาชนแจ้ง (Traffy 24 ชม.)': layers.traffy,
    'ตำแหน่งจากข่าว / YouTube': layers.news,
    'ระดับน้ำคลอง/แม่น้ำ': layers.wl,
    'ปริมาณฝน 24 ชม.': layers.rain,
    'เรดาร์ฝน (RainViewer)': layers.radar,
    'กล้อง CCTV สาธารณะ': layers.cam,
    'ขอบเขตเขต': layers.districts,
  }, { collapsed: true, position: 'topright' }).addTo(map);

  // พื้นที่กดอย่างน้อย 22 px รอบจุด (จุดเล็กก็ยังกดง่ายบนมือถือ) โดยขนาดที่มองเห็นเท่าเดิม
  const icon = (cls, color, text = '', size = 18, extra = '') => {
    const hit = Math.max(size, 22);
    return L.divIcon({
      className: '', iconSize: [hit, hit], iconAnchor: [hit / 2, hit / 2], popupAnchor: [0, -size / 2],
      html: `<div class="mkhit" style="width:${hit}px;height:${hit}px"><div class="mk ${cls} ${extra}" style="--c:${color};width:${size}px;height:${size}px">${text}</div></div>`,
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
    const failed = Object.entries(FEEDS).filter(([k, f]) => f.status === 'fail' && k !== 'radar' && k !== 'cam' && !(k === 'web' && /ยังไม่ได้เปิด/.test(f.msg || ''))).map(([, f]) => f);
    $('warn').hidden = !failed.length;
    $('warn').textContent = failed.length ? `ดึงข้อมูลไม่สำเร็จ ${failed.length} แหล่ง (${failed.map((f) => f.name.split(' – ')[0]).join(', ')}) ตัวเลขอาจไม่ครบ – ดูแท็บ "แหล่งข้อมูล"` : '';
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
  function drawSensors() {
    layers.sensor.clearLayers();
    if (!S.sensor) { $('kSensor').textContent = '–'; return; }
    for (const x of S.sensor) {
      const flooded = x.lv > 0;
      const size = flooded ? 18 : 8;
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
        <h3>${esc(e.title)}</h3><div>${esc(e.description || '').slice(0, 500)}</div>
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
    for (const x of S.traffy) {
      const r = x.r;
      const html = `<div class="pp">${badge(x.lv)} <span class="m">ประชาชนแจ้ง · ยังไม่ยืนยัน</span>
        <div style="margin-top:6px">${esc((r.description || '').slice(0, 320))}</div>
        ${r.photo_url ? `<img loading="lazy" src="${esc(r.photo_url)}" alt="ภาพจากผู้แจ้ง" referrerpolicy="no-referrer">` : ''}
        <div class="m" style="margin-top:6px">${esc(r.address || '')}<br>แจ้งเมื่อ ${fmtDT(x.t)} (${ago(x.t)}) · สถานะ: ${esc(r.state || '')}<br>
        <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.ticket_id)}" target="_blank" rel="noopener">ดูเรื่อง ${esc(r.ticket_id)}</a></div></div>`;
      x.marker = L.marker([x.la, x.lo], { icon: icon('traffy', LEVEL[x.lv].color, '', 14), zIndexOffset: 400 }).bindPopup(html, { maxWidth: 300 }).addTo(layers.traffy);
    }
    $('kTraffy').textContent = S.traffy.length;
    renderFloodList(); renderCams();
  }

  // ---------- 4) ThaiWater ฝน ----------
  async function loadRain() {
    setFeed('rain', 'loading');
    try {
      const r = await Flood.fetchRain();
      S.rain = r.items;
      setFeed('rain', 'ok', r.msg, r.newest);
    } catch (e) { S.rain = null; setFeed('rain', 'fail', Flood.errMsg('rain', e)); }
    drawRain();
  }
  function drawRain() {
    layers.rain.clearLayers();
    if (!S.rain) { $('kRain').textContent = '–'; $('listRain').innerHTML = '<div class="muted small">ไม่มีข้อมูลฝน</div>'; return; }
    for (const s of S.rain) {
      const st = rainStep(s.mm);
      const html = `<div class="pp"><div class="m">สถานีวัดฝน · ${esc(th(s.x.agency && s.x.agency.agency_shortname))}</div><h3>${esc(th(s.x.station.tele_station_name))}</h3>
        ${s.mm > RAIN_HEAVY_MM ? badge(3, 'ฝน' + st[2]) : ''}
        <div><span class="big">${s.mm}</span> มม. / 24 ชม. (${st[2]})${s.mm1 != null ? ` · ${s.mm1} มม. ชั่วโมงล่าสุด` : ''}</div>
        <div class="m">เขต${esc(th(s.x.geocode.amphoe_name))} · ${fmtDT(s.t)} (${ago(s.t)})</div></div>`;
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
    const top = [...S.rain].sort((a, b) => b.mm - a.mm);
    $('kRain').textContent = top.length ? top[0].mm.toFixed(0) : '–';
    $('kRainAt').textContent = top.length ? 'มม. · ' + th(top[0].x.station.tele_station_name) : 'มม.';
    listInto('listRain', top.filter((s) => s.mm > 0).slice(0, 6), (s) => ({
      dot: s.mm > RAIN_HEAVY_MM ? heavyRed(s.mm) : rainStep(s.mm)[1], title: th(s.x.station.tele_station_name), sub: `เขต${th(s.x.geocode.amphoe_name)} · ${fmtTime(s.t)}`, right: s.mm + ' มม.', go: s,
    }), 'ไม่มีฝนใน 24 ชม. ที่ผ่านมา');
  }

  // ฝนหนัก: แดงอ่อน (35 มม.) → แดงเข้ม (≥ 150 มม.) ไล่ตามปริมาณฝน
  function heavyRed(mm) {
    const t = Math.max(0, Math.min(1, (mm - RAIN_HEAVY_MM) / (150 - RAIN_HEAVY_MM)));
    const from = [245, 150, 146], to = [122, 14, 10];
    return 'rgb(' + from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(',') + ')';
  }

  // ---------- 5) ThaiWater ระดับน้ำ ----------
  async function loadWl() {
    setFeed('wl', 'loading');
    try {
      const r = await Flood.fetchWl();
      S.wl = r.items;
      setFeed('wl', 'ok', r.msg, r.newest);
    } catch (e) { S.wl = null; setFeed('wl', 'fail', Flood.errMsg('wl', e)); }
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
      s.marker = L.marker([s.la, s.lo], { icon: icon('wl', LEVEL[lv].color, '', 18, s.stale ? 'stale' : ''), zIndexOffset: 200 }).bindPopup(html).addTo(layers.wl);
    }
    const hi = S.wl.filter((s) => !s.stale && s.pct != null).sort((a, b) => b.pct - a.pct).slice(0, 6);
    listInto('listWl', hi, (s) => ({ dot: LEVEL[wlLevel(s.pct)].color, title: th(s.x.station.tele_station_name), sub: `${trend(s) || 'ไม่มีแนวโน้ม'} · ${fmtTime(s.t)}`, right: s.pct.toFixed(0) + '%', go: s }), 'ไม่มีสถานีที่มีค่าล่าสุด');
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
      if (!yt || yt.status === 'no-key') setFeed('youtube', 'fail', 'ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY');
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
      x.marker = L.marker([x.la, x.lo], { icon: icon('cam', '#1d2330', '▶', 12), zIndexOffset: -100 })
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
      'ไม่มีกล้องสาธารณะใกล้จุดน้ำท่วมในขณะนี้ (กล้องทั้งหมดแสดงบนแผนที่เป็นสี่เหลี่ยมสีดำ ▶ กดเพื่อดูภาพสด)');
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
    Promise.allSettled([loadSensors(), loadEvents(), loadTraffy(), loadRain(), loadWl(), loadNews(), loadTmd(), loadRadar(), S.cam ? null : loadCams()])
      .then(() => { $('updated').textContent = `อัปเดตหน้าเว็บ ${fmtTime(new Date(last))} · รีเฟรชอัตโนมัติทุก 15 นาที`; renderCams(); });
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > REFRESH_MS) refresh(); });
  setInterval(refresh, REFRESH_MS);
  loadDistricts();
  refresh();
  // ให้ js/report.js (ระบบปักหมุดแจ้งน้ำท่วม) ใช้แผนที่และชั้นข้อมูลเดียวกัน
  window.FloodMap = { map, layers, setFeed, icon, minimizePanel, isMobile };
})();
