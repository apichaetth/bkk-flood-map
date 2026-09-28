/* ส่วนกลางที่ใช้ร่วมกันระหว่างหน้าสรุป (index.html) และหน้าแผนที่ (map.html)
 * - ตัวช่วยจัดรูปแบบ/เวลา/ระยะทาง
 * - เกณฑ์ความรุนแรง
 * - ฟังก์ชันดึงข้อมูลแต่ละแหล่ง คืนค่า { items, newest, msg } หรือ throw เมื่อดึงไม่ได้
 * ข้อมูลเรียลไทม์ดึงจากเบราว์เซอร์ของผู้ชมโดยตรง เพราะบางแหล่ง (เช่นเซ็นเซอร์ กทม.) เปิดให้เฉพาะ IP ในประเทศไทย
 */
window.Flood = (function () {
  'use strict';

  const REFRESH_MS = 15 * 60 * 1000;
  // มือถือ: สัญลักษณ์บนแผนที่ขนาดครึ่งหนึ่ง (พื้นที่กดยังคงอย่างน้อย 22 px)
  const MS = window.matchMedia && matchMedia('(max-width: 860px)').matches ? 0.5 : 1;
  if (MS !== 1 && window.L && L.CircleMarker) {
    L.CircleMarker.addInitHook(function () {
      if (this instanceof L.Circle || this.options.keepSize) return; // วงรัศมีเป็นเมตร / จุดตำแหน่งตัวเอง ไม่ย่อ
      // initialize ตั้ง _radius ไปแล้ว ต้องแก้ทั้งสองค่า
      this._radius = this.options.radius = Math.max(2.5, this.options.radius * MS);
      if (this.options.weight > 1.5) this.options.weight = Math.max(1.2, this.options.weight * 0.7);
    });
  }
  const TZ = 'Asia/Bangkok';
  const BBOX = { s: 13.48, n: 13.97, w: 100.32, e: 100.95 }; // กรอบ กทม.
  const TRAFFY_WINDOW_H = 24;
  const SENSOR_STALE_H = 3;
  const WL_STALE_H = 6;
  const RAIN_HEAVY_MM = 35;
  const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
  const BMA = 'https://floodbangkok.bangkok.go.th/bkk/dds/services/api/floods/v1/items/';
  const URL = {
    sensors: BMA + 'sensor_profile?limit=-1&fields=id,code,name,road,district,lat,long',
    // ขอเฉพาะค่าใน 3 ชม. ล่าสุด เพื่อลดภาระเซิร์ฟเวอร์ กทม. (ล่มบ่อยช่วงฝนตกหนัก)
    notif: BMA + 'flood_notification?limit=600&sort=-date_created&fields=sensor_profile,value,date_created&filter[date_created][_gte]=' + encodeURIComponent('$NOW(-3 hours)'),
    notifFallback: BMA + 'flood_notification?limit=600&sort=-date_created&fields=sensor_profile,value,date_created',
    events: 'https://event.longdo.com/feed/json',
    traffy: 'https://publicapi.traffy.in.th/share/teamchadchart/search?limit=500',
    rain: TW + 'rain_24h',
    wl: TW + 'waterlevel_load',
    cams: 'https://camera.longdo.com/feed/?command=json',
    radar: 'https://api.rainviewer.com/public/weather-maps.json',
    news: 'data/news.json',
    tmd: 'data/tmd.json',
    meta: 'data/meta.json',
    districts: 'data/districts.geojson',
    fbPages: 'data/facebook-pages.json',
  };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const inBkk = (la, lo) => la >= BBOX.s && la <= BBOX.n && lo >= BBOX.w && lo <= BBOX.e;
  // รอบขอบ กทม. ประมาณ 10 กม. (นนทบุรี ปทุมธานี สมุทรปราการ ฯลฯ)
  const nearBkk = (la, lo) => la >= BBOX.s - 0.1 && la <= BBOX.n + 0.12 && lo >= BBOX.w - 0.1 && lo <= BBOX.e + 0.12;
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
  async function getJSON(url, ms = 45000, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : e.message || 'เชื่อมต่อไม่ได้');
    } finally { clearTimeout(t); }
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* เก็บไม่ได้ก็ไม่เป็นไร */ } },
  };

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
  const SEV_LV = { 'สูง': 3, 'กลาง': 2, 'ต่ำ': 1 };

  // ประเมินความรุนแรงจากข้อความรายงาน (iTIC / Traffy)
  function levelFromText(text) {
    const t = String(text || '');
    let cm = null;
    for (const m of t.matchAll(/(\d{1,3})(?:\s*[-–~]\s*(\d{1,3}))?\s*(?:ซ\.?\s?ม\.?|ซม|เซน(?:ติเมตร)?|cm)/gi)) {
      const v = Math.max(+m[1], m[2] ? +m[2] : 0);
      if (v > 0 && v < 300) cm = Math.max(cm || 0, v);
    }
    if (/น้ำลด(ลง)?แล้ว|ระบายแล้ว|แห้งแล้ว|กลับสู่ภาวะปกติ|ผ่านได้ตามปกติ/.test(t)) return { lv: 0, why: 'รายงานว่าน้ำลดแล้ว' };
    if (/ผ่านไม่ได้|ไม่สามารถผ่าน|สัญจรไม่ได้|ปิดการจราจร|ปิดถนน/.test(t)) return { lv: 3, why: 'รายงานว่ารถผ่านไม่ได้' + (cm ? ` · ${cm} ซม.` : ''), cm };
    if (cm != null) return { lv: cm >= 20 ? 3 : cm >= 10 ? 2 : 1, why: `ระดับน้ำประมาณ ${cm} ซม.`, cm };
    if (/เข่า|เอว|ต้นขา|หน้าแข้ง/.test(t)) return { lv: 3, why: 'รายงานว่าน้ำสูงระดับเข่าขึ้นไป' };
    if (/ข้อเท้า|ตาตุ่ม/.test(t)) return { lv: 1, why: 'รายงานว่าน้ำสูงระดับข้อเท้า' };
    return { lv: 2, why: 'มีรายงานน้ำท่วม ไม่ระบุความสูง' };
  }

  // ---------- ตัวดึงข้อมูลแต่ละแหล่ง ----------
  const SENSOR_CACHE = 'bkkflood.bmaSensors';

  // 1) เซ็นเซอร์น้ำท่วมถนน กทม.
  // ข้อมูลที่เครื่องในไทยส่งขึ้นมา (scripts/bma-fetch.mjs): sensors, rain, canal, road · null ถ้าไม่มีหรือเก่ากว่า 90 นาที
  let relayP = null, relayAt = 0;
  function fetchBmaRelay() {
    if (!relayP || Date.now() - relayAt > 6e4) {
      relayAt = Date.now();
      relayP = getJSON('data/bma-sensors.json', 20000).then((b) => (b && Date.now() - new Date(b.updated) < 90 * 6e4 ? b : null)).catch(() => null);
    }
    return relayP;
  }
  // ใช้ไฟล์ที่ระบบดึงไว้ (ThaiWater ทุก 15 นาที / เครื่องในไทย) ก่อน เพราะเร็วและไม่ค้าง
  // เรียกเซิร์ฟเวอร์ กทม. ตรง ๆ เฉพาะเมื่อไฟล์เก่าเกิน 30 นาทีหรือไม่มี (เซิร์ฟเวอร์นั้นตอบช้า/503 บ่อย)
  function sensorsFromRelay(b) {
    let newest = null;
    const mk = (s, la, lo, cm, tms, off) => {
      const t = tms ? new Date(tms) : null;
      if (t && (!newest || t > newest)) newest = t;
      const stale = off || !t || Date.now() - t > SENSOR_STALE_H * 36e5;
      return { s, la, lo, cm, t, stale, lv: stale || cm == null ? 0 : sensorLevel(cm) };
    };
    // ระบบ DDS/ThaiWater มีสถานะปัจจุบันของทุกจุด ใช้ก่อน ถ้าไม่มีใช้ระบบแจ้งเตือน floodbangkok
    const items = (b.road || []).length
      ? b.road.filter((x) => !x.tunnel).map((x) => mk({ code: x.c, name: x.n, road: x.road, district: x.d }, x.la, x.lo, x.cm, x.t, x.st === 'off'))
      : (b.sensors || []).map((x) => mk({ id: x.id, code: x.code, name: x.name, road: x.road, district: x.district }, x.la, x.lo, x.cm, x.t, false));
    const via = b.source === 'thaiwater' ? 'ผ่าน ThaiWater' : 'ผ่านเครื่องสำรองในไทย';
    return items.length ? { items, newest, msg: `${items.length} จุด (${via})` } : null;
  }
  async function fetchSensors() {
    const b = await fetchBmaRelay();
    const fromFile = b && Date.now() - new Date(b.updated) < 30 * 6e4 ? sensorsFromRelay(b) : null;
    if (fromFile) return fromFile;
    try { return await fetchSensorsDirect(); }
    catch (e) {
      const r = b && sensorsFromRelay(b);
      if (!r) throw e;
      return r;
    }
  }
  async function fetchSensorsDirect() {
    // เรียกตรงจากเบราว์เซอร์ (เซิร์ฟเวอร์ กทม. ปฏิเสธเครื่องนอกประเทศ รวม GitHub Actions)
    let sp = null, nt = null;
    if (!sp) {
      // ตำแหน่งเซ็นเซอร์แทบไม่เปลี่ยน: เก็บไว้ในเบราว์เซอร์ 24 ชม. ลดการเรียกซ้ำ
      const c = store.get(SENSOR_CACHE);
      if (c && Date.now() - c.t < 864e5) sp = c.sp;
      if (!sp) { sp = await getJSON(URL.sensors, 30000); store.set(SENSOR_CACHE, { t: Date.now(), sp }); }
      // บางเวอร์ชันของ API อาจไม่รองรับตัวกรองเวลา (ตอบ 4xx) ให้ลองแบบไม่กรอง
      nt = await getJSON(URL.notif, 30000).catch((e) => (/HTTP 4\d\d/.test(e.message) ? getJSON(URL.notifFallback, 30000) : Promise.reject(e)));
    }
    const latest = new Map();
    for (const n of nt.data || []) if (!latest.has(n.sensor_profile)) latest.set(n.sensor_profile, n);
    let newest = null;
    const items = (sp.data || [])
      .filter((s) => String(s.code || '').startsWith('FL.') && num(s.lat) && num(s.long))
      .map((s) => {
        const n = latest.get(s.id);
        const t = n ? isoDate(n.date_created) : null;
        const cm = n ? num(n.value) : null;
        if (t && (!newest || t > newest)) newest = t;
        const stale = !t || Date.now() - t > SENSOR_STALE_H * 36e5;
        return { s, la: num(s.lat), lo: num(s.long), cm, t, stale, lv: stale || cm == null ? 0 : sensorLevel(cm) };
      });
    return { items, newest, msg: `${items.length} จุด` };
  }

  // 2) รายงานน้ำท่วมจากหน่วยงาน / iTIC / Longdo
  async function fetchEvents() {
    // สำเนาย่อที่ระบบดึงไว้ทุก 15 นาที (เล็กกว่าต้นฉบับมาก) ถ้าเก่าเกิน 40 นาทีค่อยดึงตรง
    let d = null;
    const f = await getJSON('data/events.json', 15000, { cache: 'no-cache' }).catch(() => null);
    if (f && Array.isArray(f.items) && Date.now() - new Date(f.updated) < 40 * 6e4) d = f.items;
    else d = await getJSON(URL.events).catch((e) => { if (f && Array.isArray(f.items)) return f.items; throw e; });
    if (!Array.isArray(d)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    const now = Date.now();
    let newest = null;
    const items = d.filter((e) => String(e.type) === '6' || e.icon === 'flood')
      .map((e) => ({ e, la: num(e.latitude), lo: num(e.longitude), start: bkkDate(e.start), stop: bkkDate(e.stop), ...levelFromText(`${e.title} ${e.description}`) }))
      .filter((x) => x.la && x.lo && inBkk(x.la, x.lo) && (!x.stop || x.stop >= now) && (!x.start || x.start <= now + 36e5) && x.lv > 0);
    items.forEach((x) => { if (x.start && (!newest || x.start > newest)) newest = x.start; });
    return { items, newest, msg: `${items.length} จุดที่ยังมีผล` };
  }

  // 3) Traffy Fondue
  // เอาเฉพาะเรื่องน้ำท่วมจริง:
  // - ถ้าถูกจัดประเภทแล้ว (problem_type_abdul / type) ต้องมีประเภท "น้ำท่วม" (ตัดเรื่องท่อ/ถนน/ขยะ ฯลฯ ที่แค่เอ่ยคำว่าน้ำ)
  // - ถ้ายังไม่ถูกจัดประเภท (เรื่องใหม่) ข้อความต้องพูดถึงน้ำท่วม/น้ำขังชัดเจน และไม่ใช่เรื่องประปา/ท่อแตก
  const FLOOD_RE = /น้ำท่วม|ท่วมขัง|ท่วมถนน|น้ำขัง|น้ำรอระบาย|รอการระบาย|น้ำเจิ่ง/;
  const NOT_FLOOD_RE = /ประปา|น้ำไม่ไหล|ท่อแตก|ท่อรั่ว|น้ำรั่ว|น้ำเสีย|กลิ่น|ยุง/;
  function isFloodTicket(r) {
    const types = [].concat(r.problem_type_abdul || [], r.type ? String(r.type).replace(/[{}]/g, '').split(',') : [])
      .map((t) => String(t).trim()).filter(Boolean);
    if (types.length) return types.includes('น้ำท่วม');
    const d = String(r.description || '');
    return FLOOD_RE.test(d) && !NOT_FLOOD_RE.test(d);
  }
  // เบราว์เซอร์ดึงจาก Traffy ตรง ๆ มักไม่ได้ (CORS) จึงใช้ไฟล์ data/traffy.json ที่ GitHub Actions ดึงไว้ทุก 15 นาทีเป็นหลัก
  // ถ้าไฟล์ไม่มี/เก่าเกิน 2 ชม. ค่อยลองดึงตรง
  // short=true: ไฟล์ย่อ 24 ชม. (เล็กกว่าหลายเท่า) ถ้ายังไม่มีค่อยใช้ไฟล์เต็ม
  async function traffyRaw(short) {
    // ใช้ไฟล์ที่ GitHub Actions เก็บไว้ก่อนเสมอ (เร็ว) — API ของ Traffy ตอบช้าหรือล่มบ่อย รอได้เป็นนาที
    let file = null;
    if (short) try { file = await getJSON('data/traffy-24h.json', 20000, { cache: 'no-cache' }); } catch (e) { /* ยังไม่มีไฟล์ย่อ */ }
    if (!file) try { file = await getJSON('data/traffy.json', 20000, { cache: 'no-cache' }); } catch (e) { /* ยังไม่มีไฟล์ */ }
    const fromFile = () => ({ results: file.results, updated: new Date(file.updated), since: file.since ? new Date(file.since) : null, via: 'file',
      stale: Date.now() - new Date(file.updated) > 2 * 36e5 });
    if (file && Array.isArray(file.results) && (file.results.length || (short && !fromFile().stale))) return fromFile();
    // ไม่มีไฟล์เลย: ลองดึงตรง แต่ไม่รอนานเกิน 25 วินาที
    try {
      const d = await getJSON(URL.traffy, 25000);
      if (Array.isArray(d.results)) return { results: d.results, updated: new Date(), since: null, via: 'direct' };
    } catch (e) {
      if (file && Array.isArray(file.results)) return fromFile();
      throw new Error('ระบบของ Traffy Fondue ไม่ตอบสนองขณะนี้ (' + e.message + ')');
    }
    throw new Error('ไม่มีข้อมูล Traffy');
  }
  async function fetchTraffy() {
    const d = await traffyRaw(true);
    if (!Array.isArray(d.results)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    const cutoff = Date.now() - TRAFFY_WINDOW_H * 36e5;
    let newest = null;
    const items = d.results
      .map((r) => ({ r, t: isoDate(r.timestamp), lo: num(r.coords && r.coords[0]), la: num(r.coords && r.coords[1]) }))
      .filter((x) => x.la && x.lo && x.t && x.t >= cutoff && inBkk(x.la, x.lo) && x.r.state !== 'เสร็จสิ้น'
        && isFloodTicket(x.r))
      .map((x) => ({ ...x, ...(x.r.lv != null ? { lv: x.r.lv, why: x.r.why, cm: x.r.cm } : levelFromText(x.r.description)) }))
      .filter((x) => x.lv > 0);
    items.forEach((x) => { if (!newest || x.t > newest) newest = x.t; });
    // บอกช่วงเวลาที่ข้อมูลครอบคลุมจริง (500 เรื่องล่าสุดอาจย้อนหลังได้ไม่ถึง 24 ชม. ช่วงคนแจ้งเยอะ)
    const via = d.via === 'file' ? `ข้อมูลที่ระบบดึงไว้เมื่อ ${fmtDT(d.updated)}` : 'ดึงตรงจาก Traffy';
    return { items, newest, msg: `พบเรื่องน้ำท่วม ${items.length} เรื่องใน 24 ชม. · ${via}` };
  }

  // 4) ThaiWater ฝน 24 ชม.
  // ThaiWater: ใช้สำเนาย่อที่ GitHub Actions เก็บไว้ก่อน (เล็กกว่าหลายเท่า) ถ้าเก่าเกิน 40 นาทีหรือไม่มี ค่อยดึงตรง
  async function twJSON(local, live) {
    let d = null;
    try {
      d = await getJSON(local, 20000, { cache: 'no-cache' });
      if (d.updated && Date.now() - new Date(d.updated) < 40 * 60000) return d;
    } catch (e) { /* ไม่มีสำเนา */ }
    // สำเนาเก่า: ลองดึงตรง ถ้าไม่ได้ใช้สำเนาเก่าไปก่อน (ดีกว่าไม่มีข้อมูล)
    try { return await getJSON(live, 120000); } catch (e) { if (d && (d.data || d.waterlevel_data)) return d; throw e; }
  }
  async function fetchRain() {
    const d = await twJSON('data/tw-rain.json', URL.rain);
    if (!Array.isArray(d.data)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    const cutoff = Date.now() - 30 * 36e5;
    let newest = null;
    const toSt = (x) => ({ x, t: bkkDate(x.rainfall_datetime), la: num(x.station && x.station.tele_station_lat), lo: num(x.station && x.station.tele_station_long), mm: num(x.rain_24h), mm1: num(x.rain_1h) });
    const ok = (s) => s.la && s.lo && s.t && s.t >= cutoff && s.mm != null;
    const items = d.data.filter((x) => x.geocode && String(x.geocode.province_code) === '10').map(toSt).filter(ok);
    // สถานีจังหวัดติดขอบ กทม. (แสดงบนแผนที่ละเอียดเท่านั้น ไม่นับในสรุป กทม.)
    const edge = d.data.filter((x) => x.geocode && String(x.geocode.province_code) !== '10').map(toSt).filter((s) => ok(s) && nearBkk(s.la, s.lo));
    items.forEach((s) => { if (!newest || s.t > newest) newest = s.t; });
    // ฝนลุ่มเจ้าพระยา: สรุปรายจังหวัดจากต้นน้ำลงมา (ฝนต้นน้ำจะกลายเป็นน้ำเหนือไหลลง กทม.)
    const basin = BASIN_PROVINCES.map(([code, name]) => {
      const st = d.data.filter((x) => x.geocode && String(x.geocode.province_code) === code)
        .map((x) => ({ t: bkkDate(x.rainfall_datetime), mm: num(x.rain_24h), name: th(x.station && x.station.tele_station_name) }))
        .filter((x) => x.t && x.t >= cutoff && x.mm != null);
      if (!st.length) return { code, name, n: 0 };
      const top = st.reduce((a, b) => (b.mm > a.mm ? b : a));
      return { code, name, n: st.length, max: top.mm, maxAt: top.name, mean: st.reduce((a, b) => a + b.mm, 0) / st.length };
    });
    return { items, edge, basin, newest, msg: `${items.length} สถานีใน กทม. + ${edge.length} สถานีรอบขอบ` };
  }
  const BASIN_PROVINCES = [['60', 'นครสวรรค์'], ['61', 'อุทัยธานี'], ['18', 'ชัยนาท'], ['17', 'สิงห์บุรี'], ['16', 'ลพบุรี'], ['15', 'อ่างทอง'],
    ['72', 'สุพรรณบุรี'], ['14', 'พระนครศรีอยุธยา'], ['13', 'ปทุมธานี'], ['12', 'นนทบุรี'], ['10', 'กรุงเทพมหานคร'], ['11', 'สมุทรปราการ']];

  // 5) ThaiWater ระดับน้ำ
  async function fetchWl() {
    const d = await twJSON('data/tw-wl.json', URL.wl);
    const arr = d && d.waterlevel_data && d.waterlevel_data.data;
    if (!Array.isArray(arr)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    let newest = null;
    const toSt = (x) => ({ x, t: bkkDate(x.waterlevel_datetime), la: num(x.station && x.station.tele_station_lat), lo: num(x.station && x.station.tele_station_long), pct: num(x.storage_percent), msl: num(x.waterlevel_msl), prev: num(x.waterlevel_msl_previous), bank: num(x.station && x.station.min_bank) });
    const fin = (s) => ({ ...s, stale: Date.now() - s.t > WL_STALE_H * 36e5 });
    const items = arr.filter((x) => x.geocode && String(x.geocode.province_code) === '10').map(toSt).filter((s) => s.la && s.lo && s.t).map(fin);
    const edge = arr.filter((x) => x.geocode && String(x.geocode.province_code) !== '10').map(toSt).filter((s) => s.la && s.lo && s.t && nearBkk(s.la, s.lo)).map(fin);
    items.forEach((s) => { if (!newest || s.t > newest) newest = s.t; });
    // น้ำเหนือ: สถานีสำคัญบนแม่น้ำเจ้าพระยา เรียงจากต้นน้ำลงมา
    const upstream = CPY_STATIONS.map(([code, label]) => {
      const x = arr.find((y) => y.station && String(y.station.tele_station_oldcode) === code);
      if (!x) return { code, label, missing: true };
      const t = bkkDate(x.waterlevel_datetime);
      return { code, label, x, t, la: num(x.station.tele_station_lat), lo: num(x.station.tele_station_long), pct: num(x.storage_percent),
        msl: num(x.waterlevel_msl), prev: num(x.waterlevel_msl_previous), bank: num(x.station.min_bank), q: num(x.discharge),
        stale: !t || Date.now() - t > WL_STALE_H * 36e5 };
    });
    return { items, edge, upstream, newest, msg: `${items.length} สถานีใน กทม. + ${edge.length} รอบขอบ · น้ำเหนือ ${upstream.filter((u) => !u.missing).length} สถานี` };
  }
  const CPY_STATIONS = [
    ['C.2', 'นครสวรรค์ (ค่ายจิรประวัติ)'],
    ['C.13', 'ท้ายเขื่อนเจ้าพระยา ชัยนาท'],
    ['C.35', 'บ้านป้อม อยุธยา'],
    ['CPY014', 'สะพานนวลฉวี นนทบุรี'],
    ['C.12', 'กรมชลประทานสามเสน กทม.'],
    ['CPY015', 'สะพานกรุงเทพ กทม.'],
  ];

  // 6) ข่าว + คลิป (ไฟล์ที่ GitHub Actions สร้าง)
  async function fetchNews() {
    const [d, meta] = await Promise.all([getJSON(URL.news + '?t=' + Date.now()), getJSON(URL.meta + '?t=' + Date.now()).catch(() => null)]);
    return { items: d.items || [], updated: new Date(d.updated), sources: (meta && meta.sources) || {} };
  }

  // 7) ประกาศกรมอุตุฯ
  async function fetchTmd() {
    const d = await getJSON(URL.tmd + '?t=' + Date.now());
    return { items: d.items || [], updated: new Date(d.updated) };
  }

  // 7b) ThaiWater พยากรณ์ฝน + เขื่อน (GitHub Actions เตรียมไว้ใน data/thaiwater.json)
  const fetchTw = () => getJSON('data/thaiwater.json', 20000, { cache: 'no-cache' });
  // กรมอุตุฯ พยากรณ์ฝนรายชั่วโมง 24 ชม. (จุดกริดรอบ กทม.)
  const fetchTmdFcst = () => getJSON('data/tmd-forecast.json', 20000, { cache: 'no-cache' });
  const twBkkHeavy = (d) => (d && d.heavy || []).find((p) => p.code === '10') || null;

  // 8) ประชาชนแจ้งผ่านเว็บนี้ (Google Apps Script) — endpoint อยู่ใน data/report-config.json
  let reportCfg = null;
  async function reportEndpoint() {
    if (!reportCfg) reportCfg = getJSON('data/report-config.json?t=' + Date.now()).catch(() => ({}));
    const c = await reportCfg;
    return /^https:\/\/script\.google(usercontent)?\.com\//.test(c.endpoint || '') ? c.endpoint : '';
  }
  async function fetchWebReports() {
    const ep = await reportEndpoint();
    if (!ep) throw new Error('ยังไม่ได้เปิดระบบแจ้ง');
    const d = await getJSON(ep + '?action=list&t=' + Date.now(), 30000);
    if (!d.ok) throw new Error(d.error || 'อ่านรายงานไม่ได้');
    const items = (d.reports || []).filter((r) => r.status === 'open' && inBkk(r.lat, r.lng))
      .map((r) => ({ r, la: r.lat, lo: r.lng, t: new Date(r.created_at), lv: WEB_LEVEL[r.level] || 2 }));
    let newest = null;
    items.forEach((x) => { if (!newest || x.t > newest) newest = x.t; });
    return { items, newest, msg: `${items.length} จุดที่ยังไม่มีคนแจ้งว่าน้ำลด` };
  }
  // ระดับน้ำที่ผู้แจ้งเลือก -> ระดับความรุนแรง
  const WEB_LEVEL = { 'ข้อเท้า': 1, 'ครึ่งแข้ง': 2, 'เข่า': 3, 'เอว': 3, 'สูงกว่าเอว': 3, 'ไม่ระบุ': 2 };
  function deviceId() {
    let id = store.get('bkkflood.device');
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); store.set('bkkflood.device', id); }
    return id;
  }

  // 9) กล้อง CCTV สาธารณะ และเรดาร์ฝน: ลองดึงตรงก่อน ถ้าไม่ได้ใช้ไฟล์ที่ GitHub Actions ดึงไว้
  async function fetchCams() {
    try {
      const d = await getJSON(URL.cams, 30000);
      if (Array.isArray(d)) return d;
      throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    } catch (e) {
      const f = await getJSON('data/cams.json?t=' + Date.now(), 20000).catch(() => null);
      if (f && Array.isArray(f.cams)) return f.cams;
      throw e;
    }
  }
  async function fetchRadar() {
    try { return await getJSON(URL.radar, 20000); }
    catch (e) {
      const f = await getJSON('data/radar.json?t=' + Date.now(), 20000).catch(() => null);
      if (f && f.radar) return f;
      throw e;
    }
  }

  // ปุ่ม "ตำแหน่งของฉัน" ใต้ปุ่มซูม: ซูมไปตำแหน่งปัจจุบัน แสดงจุดสีน้ำเงินและวงความแม่นยำ
  function addLocate(map, onLocated) {
    let marker = null, ring = null;
    const Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar locate-ctl');
        const a = L.DomUtil.create('a', '', box);
        a.href = '#'; a.title = 'ไปที่ตำแหน่งปัจจุบันของฉัน'; a.setAttribute('role', 'button'); a.setAttribute('aria-label', 'ตำแหน่งปัจจุบัน');
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          if (!navigator.geolocation) { alert('อุปกรณ์นี้ไม่รองรับการหาตำแหน่ง'); return; }
          box.classList.add('busy');
          navigator.geolocation.getCurrentPosition((p) => {
            box.classList.remove('busy');
            const ll = [p.coords.latitude, p.coords.longitude];
            if (marker) { marker.remove(); ring.remove(); }
            ring = L.circle(ll, { radius: Math.min(p.coords.accuracy || 50, 1000), color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
            marker = L.circleMarker(ll, { keepSize: true, radius: 7, color: '#fff', weight: 2.5, fillColor: '#1a73e8', fillOpacity: 1 }).bindTooltip('ตำแหน่งของฉัน').addTo(map);
            map.setView(ll, Math.max(map.getZoom(), 16));
            if (onLocated) onLocated(ll);
          }, (err) => {
            box.classList.remove('busy');
            alert(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์' : 'หาตำแหน่งไม่ได้ ลองใหม่อีกครั้ง');
          }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
        });
        return box;
      },
    });
    return new Ctl().addTo(map);
  }

  // ข้อความผิดพลาดที่อ่านเข้าใจง่าย
  function errMsg(key, e) {
    // เซิร์ฟเวอร์ กทม. ตอบ 503 "Under pressure" โดยไม่มี CORS header เบราว์เซอร์จึงเห็นเป็น Failed to fetch
    if (key === 'sensor' && /fetch|HTTP 5/i.test(e.message)) return 'ระบบของ กทม. ไม่ตอบสนอง (มักเกิดช่วงมีผู้ใช้มาก) จะลองใหม่ทุก 15 นาที';
    return e.message;
  }

  // ---------- เขต ----------
  let districtsPromise = null;
  const loadDistricts = () => (districtsPromise ||= getJSON(URL.districts));
  // หาเขตจากพิกัดด้วย ray casting (geojson เป็น MultiPolygon [lng, lat])
  function inRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function districtAt(geo, lat, lng) {
    for (const f of geo.features) for (const poly of f.geometry.coordinates) if (inRing(lng, lat, poly[0])) return f.properties.name;
    return '';
  }

  // แนวโน้มน้ำ (data/trends.json เทียบ 30 นาทีก่อน): สี = สถานการณ์ตอนนี้ · ลูกศร = ทิศทาง (สองอัน = เร็ว/มาก)
  const TREND_Z = { fast: ['⬆⬆', 'เพิ่มขึ้นมาก'], up: ['⬆', 'เพิ่มขึ้น'], peak: ['⏸', 'ใกล้จุดสูงสุด'], down: ['⬇', 'ลดลง'], dfast: ['⬇⬇', 'ลดลงมาก'], flat: ['➖', 'ทรงตัว'] };
  const TREND_KEYS = ['fast', 'up', 'peak', 'down', 'dfast', 'flat'];
  // ระดับสถานการณ์ตอนนี้ของจุดแนวโน้ม: ถนนตามความสูงน้ำ (ซม.) · คลองตามเกณฑ์ กทม. (เตือนภัย/วิกฤต)
  const trendLv = (x) => (x.k === 'canal' || x.crit !== undefined ? (x.st >= 2 ? 3 : x.st === 1 ? 2 : 0) : sensorLevel(x.v));
  // ป้ายลูกศรบนแผนที่ (divIcon) สีพื้นตามระดับ
  const trendIcon = (tr, lv) => L.divIcon({ className: '', iconSize: [34, 24], iconAnchor: [17, 12],
    html: `<div class="trz${LEVEL[lv].dark ? ' dark' : ''}${TREND_Z[tr][0].length > 1 ? ' two' : ''}" style="--c:${LEVEL[lv].color}">${TREND_Z[tr][0]}</div>` });
  // รวมแนวโน้มรายเขต: Map ชื่อเขต → { fast, up, peak, down, dfast, z (แนวโน้มหลักของเขต) }
  function trendByDistrict(d, geo) {
    const by = new Map();
    if (!d) return by;
    for (const x of [...(d.road || []), ...(d.canal || [])]) {
      if (!TREND_Z[x.tr] || !x.la || !x.lo) continue;
      const n = (geo && districtAt(geo, x.la, x.lo)) || x.d;
      if (!n) continue;
      const c = by.get(n) || { fast: 0, up: 0, peak: 0, down: 0, dfast: 0, flat: 0 };
      c[x.tr]++; by.set(n, c);
    }
    for (const c of by.values()) {
      const net = 2 * c.fast + c.up - c.down - 2 * c.dfast;
      c.z = net > 0 ? (c.fast && net >= 2 ? 'fast' : 'up') : net < 0 ? (c.dfast && net <= -2 ? 'dfast' : 'down') : c.peak ? 'peak' : c.fast + c.up ? 'up' : c.down + c.dfast ? 'down' : 'flat';
    }
    return by;
  }
  const trendText = (c) => TREND_KEYS.filter((k) => c[k]).map((k) => `${TREND_Z[k][1]} ${c[k]} จุด`).join(' · ');
  // ลูกศรรายจุด (หน้าแรก): สีตามสถานการณ์ตอนนี้ กดดูรายละเอียดได้
  function trendZones(layer, d) {
    layer.clearLayers();
    if (!d || !window.L) return 0;
    const items = [...(d.road || []).map((x) => ({ ...x, k: 'road' })), ...(d.canal || []).map((x) => ({ ...x, k: 'canal' }))]
      .filter((x) => TREND_Z[x.tr] && x.tr !== 'flat' && x.la && x.lo); // ทรงตัวไม่ต้องปักลูกศร (แผนที่จะรกเกิน)
    for (const x of items) {
      const lv = trendLv(x), road = x.k === 'road', dp = road ? 0 : 2, unit = road ? ' ซม.' : ' ม.';
      L.marker([x.la, x.lo], { icon: trendIcon(x.tr, lv), zIndexOffset: 100 * lv + (x.tr === 'fast' ? 50 : 0) })
        .bindPopup(`<div class="pp"><div class="m">แนวโน้มน้ำ · ${road ? 'เซ็นเซอร์ถนน' : 'คลอง'} กทม.</div><h3>${esc(x.n || '')}</h3>`
          + `${road ? badge(lv) : badge(lv, x.st >= 2 ? 'วิกฤต' : x.st === 1 ? 'เตือนภัย' : 'ปกติ')} <b>${TREND_Z[x.tr][0]} ${TREND_Z[x.tr][1]}</b>`
          + `<div class="m">ตอนนี้ ${(+x.v).toFixed(dp)}${unit} (${x.d30 > 0 ? '+' : ''}${(+x.d30).toFixed(dp)}${unit} ใน 30 นาที)`
          + `${x.eta != null ? ` · ถึงวิกฤตใน ~${x.eta} ชม.` : ''}${x.d ? '<br>เขต' + esc(x.d) : ''}</div></div>`).addTo(layer);
    }
    return items.length;
  }

  return {
    REFRESH_MS, MS, TZ, RAIN_HEAVY_MM, URL,
    $, esc, num, inBkk, nearBkk, th, fmtTime, fmtDT, ago, bkkDate, isoDate, distKm, getJSON, cssVar, store,
    LEVEL, badge, sensorLevel, wlLevel, rainStep, SEV_LV, levelFromText,
    fetchSensors, fetchBmaRelay, fetchEvents, fetchTraffy, traffyRaw, fetchCams, fetchRadar, isFloodTicket, fetchWebReports, fetchTw, fetchTmdFcst, twBkkHeavy, reportEndpoint, deviceId, WEB_LEVEL, fetchRain, fetchWl, fetchNews, fetchTmd, errMsg,
    loadDistricts, districtAt, addLocate, trendZones, trendByDistrict, trendText, trendIcon, TREND_Z, TREND_KEYS,
  };
})();

// ---------- เมนู: คอม = แถบบน 5 หน้า + "เพิ่มเติม ▾" · มือถือ = แถบล่าง 4 ปุ่ม (แบบแอป) ----------
(function () {
  const nav = document.querySelector('nav.pages');
  if (!nav) return;
  const path = location.pathname.split('/').pop() || './';
  const here = (nav.querySelector('[aria-current="page"]') || {}).getAttribute?.('href') || (path === 'index.html' ? './' : path);
  // [ลิงก์, ชื่อบนคอม, ชื่อบนมือถือ, ไอคอน]
  const MAIN = [['./', 'หน้าแรก', 'หน้าแรก', '🏠'], ['map.html', 'แผนที่ละเอียด', 'แผนที่', '🗺️'], ['route.html', 'เส้นทางเลี่ยงน้ำ', 'เส้นทาง', '🚗'],
    ['districts.html', 'เขต', 'เขต', '📍'], ['risk.html', 'ถนนเสี่ยง', 'ถนนเสี่ยง', '⚠️']];
  const MORE = [['details.html', 'รายละเอียด (แนวโน้ม ฝน คลอง)', '📊'], ['traffy.html', 'Traffy Fondue', '📣'], ['log.html', 'บันทึกการแจ้ง', '📝'], ['about.html', 'เกี่ยวกับ', 'ℹ️']];
  const cur = (h) => (h === here ? ' aria-current="page"' : '');
  const inMore = MORE.some(([h]) => h === here);
  // คอม
  nav.innerHTML = MAIN.map(([h, t]) => `<a href="${h}"${cur(h)}>${t}</a>`).join('')
    + `<div class="pmore"><button type="button" class="${inMore ? 'on' : ''}" aria-expanded="false" aria-haspopup="true">เพิ่มเติม ▾</button>`
    + `<div class="pmenu" hidden>${MORE.map(([h, t, i]) => `<a href="${h}"${cur(h)}>${i} ${t}</a>`).join('')}</div></div>`;
  const pb = nav.querySelector('.pmore button'), pm = nav.querySelector('.pmenu');
  pb.onclick = (e) => { e.stopPropagation(); pm.hidden = !pm.hidden; pb.setAttribute('aria-expanded', String(!pm.hidden)); };
  // มือถือ: แถบล่าง 4 ปุ่ม (หน้าแรก/แผนที่/เส้นทาง/อื่น ๆ) + แผ่นเมนูอื่น ๆ (เขต ถนนเสี่ยง รายละเอียด …)
  const MOB = MAIN.slice(0, 3), SHEET = [MAIN[3], MAIN[4], ...MORE.map(([h, t, i]) => [h, t, t, i])];
  const bar = document.createElement('nav');
  bar.className = 'tabbar'; bar.setAttribute('aria-label', 'หน้า');
  bar.innerHTML = MOB.map(([h, , t, i]) => `<a href="${h}"${cur(h)}><span class="ti" aria-hidden="true">${i}</span><span>${t}</span></a>`).join('')
    + `<button type="button" class="${SHEET.some(([h]) => h === here) ? 'on' : ''}" aria-expanded="false"><span class="ti" aria-hidden="true">☰</span><span>อื่น ๆ</span></button>`;
  const sheet = document.createElement('div');
  sheet.className = 'tsheet'; sheet.hidden = true;
  sheet.innerHTML = `<div class="tsheet-in" role="menu">${SHEET.map(([h, , t, i]) => `<a href="${h}"${cur(h)} role="menuitem"><span aria-hidden="true">${i}</span>${t}</a>`).join('')}</div>`;
  document.body.append(sheet, bar);
  document.body.classList.add('has-tabbar');
  const tb = bar.querySelector('button');
  tb.onclick = (e) => { e.stopPropagation(); sheet.hidden = !sheet.hidden; tb.setAttribute('aria-expanded', String(!sheet.hidden)); };
  sheet.onclick = (e) => { if (e.target === sheet) { sheet.hidden = true; tb.setAttribute('aria-expanded', 'false'); } };
  document.addEventListener('click', (e) => {
    if (!pm.hidden && !nav.contains(e.target)) { pm.hidden = true; pb.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pm.hidden = true; sheet.hidden = true; } });
})();

// ---------- ติดตั้งเป็นแอป / เปิดได้ตอนเน็ตหลุด (sw.js ดึงจากเน็ตก่อนเสมอ) ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* ไม่รองรับก็ใช้เว็บปกติ */ }));
}

// ---------- หน้าเก่าค้างในเครื่อง: เทียบกับ version.txt ถ้าไม่ตรงโหลดใหม่ (ครั้งเดียวต่อเวอร์ชัน) ----------
(function () {
  const m = document.querySelector('meta[name="build"]');
  if (!m) return; // เปิดจากเครื่องตัวเอง ไม่มีเลขเวอร์ชัน
  const mine = m.content;
  async function check() {
    try {
      const r = await fetch('version.txt?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const live = (await r.text()).trim();
      if (!live || live === mine) return;
      const key = 'bkkflood.reloadedFor';
      if (sessionStorage.getItem(key) === live) return; // กันรีโหลดวน
      sessionStorage.setItem(key, live);
      location.reload();
    } catch (e) { /* ออฟไลน์ ไม่เป็นไร */ }
  }
  check();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();

// ---------- ภาพคาดการณ์ฝน 3 ชม. ของสำนักการระบายน้ำ กทม. (เปิดได้จากเครือข่ายในไทย ถ้าโหลดไม่ได้ซ่อนไว้) ----------
(function () {
  const fig = document.getElementById('nowcast');
  if (!fig) return;
  const img = fig.querySelector('img');
  const load = () => { img.src = 'https://dds.bangkok.go.th/Line_data/picture/radar_rain.gif?t=' + Math.floor(Date.now() / 6e5); };
  img.onerror = () => { fig.hidden = true; };
  img.onload = () => { fig.hidden = false; };
  load();
  setInterval(load, 10 * 60e3); // ภาพต้นทางอัปเดตทุก ~10 นาที
})();
