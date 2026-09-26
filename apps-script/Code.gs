/**
 * ระบบรับแจ้งน้ำท่วมจากประชาชน (Google Apps Script + Google Sheets + Google Drive)
 * วิธีติดตั้ง: ดู apps-script/README.md
 *
 * ชีต "Reports" = สถานะปัจจุบันของแต่ละหมุด (แก้ไขได้เฉพาะผ่านสคริปต์/เมนูแอดมิน)
 * ชีต "Log"     = บันทึกทุกการกระทำแบบต่อท้ายอย่างเดียว (แจ้ง / น้ำลดแล้ว / ซ่อน / กู้คืน)
 *                 แต่ละแถวมี hash ต่อจากแถวก่อนหน้า ถ้ามีคนแก้แถวเก่า ฟังก์ชัน verifyLog() จะตรวจพบ
 *
 * เว็บเรียกใช้:
 *   GET  ?action=list          รายงานที่ยังเปิดอยู่ + ที่ปิดใน 24 ชม. (ชื่อแบบย่อ)
 *   GET  ?action=log&limit=200 log ล่าสุด (ชื่อแบบย่อ)
 *   POST {action:'create', ...} แจ้งน้ำท่วม
 *   POST {action:'close', ...}  แจ้งว่าน้ำลดแล้ว (เอาหมุดออก)
 *   POST {action:'feedback', ...} ข้อความจากหน้าเกี่ยวกับ → ชีต Feedback + ส่งอีเมลถึงเจ้าของสคริปต์
 * POST ส่งเป็น Content-Type: text/plain เพื่อไม่ให้เบราว์เซอร์ต้องทำ CORS preflight
 */

const CFG = {
  FOLDER_NAME: 'bkk-flood-map uploads',
  BBOX: { s: 13.48, n: 13.97, w: 100.32, e: 100.95 }, // รับเฉพาะพิกัดใน กทม.
  MAX_PHOTOS: 3,
  MAX_PHOTO_BYTES: 2 * 1024 * 1024, // หลังย่อจากเบราว์เซอร์มักเหลือ ~300 KB
  MAX_VIDEO_BYTES: 15 * 1024 * 1024,
  PHOTO_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  VIDEO_TYPES: ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'],
  RATE_LIMIT: 6, // ต่ออุปกรณ์ ต่อ 10 นาที
  GLOBAL_LIMIT: 150, // รวมทุกคน ต่อ 10 นาที
  FEEDBACK_GLOBAL_LIMIT: 30, // ข้อความจากหน้าเกี่ยวกับ รวมทุกคน ต่อชั่วโมง (กันโควตาอีเมลหมด)
  CLOSED_VISIBLE_H: 24,
};
const LEVELS = ['ข้อเท้า', 'ครึ่งแข้ง', 'เข่า', 'เอว', 'สูงกว่าเอว', 'ไม่ระบุ'];

const REPORT_HEADERS = ['id', 'created_at', 'reporter_name', 'reporter_device', 'lat', 'lng', 'place', 'level', 'message',
  'photo_ids', 'video_id', 'video_link', 'status', 'closed_at', 'closed_by', 'closed_device', 'close_reason', 'close_photo_ids', 'updated_at'];
const LOG_HEADERS = ['log_id', 'timestamp', 'action', 'report_id', 'actor_name', 'actor_device', 'user_agent', 'lat', 'lng',
  'level', 'message', 'photo_ids', 'video_id', 'video_link', 'prev_hash', 'hash'];
const FEEDBACK_HEADERS = ['timestamp', 'name', 'contact', 'topic', 'message', 'device', 'page', 'user_agent', 'mailed'];

// ---------- ติดตั้งครั้งแรก (กด Run ฟังก์ชันนี้ 1 ครั้ง) ----------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, 'Reports', REPORT_HEADERS);
  ensureSheet_(ss, 'Log', LOG_HEADERS);
  ensureSheet_(ss, 'Feedback', FEEDBACK_HEADERS);
  folder_();
  // ป้องกันการแก้ไขชีต Log ด้วยมือโดยไม่ตั้งใจ (เจ้าของยังแก้ได้ แต่จะมีคำเตือน และ hash จะไม่ตรง)
  const log = ss.getSheetByName('Log');
  if (!log.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) log.protect().setDescription('Log ต่อท้ายอย่างเดียว').setWarningOnly(true);
  return 'ok';
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  // เก็บทุกช่องเป็นข้อความ ไม่ให้ Sheets แปลงเวลา/ตัวเลขเอง (ไม่งั้นค่าที่อ่านกลับจะไม่ตรงกับ hash)
  sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* ถูกลบไปแล้ว สร้างใหม่ */ } }
  const f = DriveApp.createFolder(CFG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

// ---------- HTTP ----------
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'log') return json_({ ok: true, log: publicLog_(Math.min(1000, Number(p.limit) || 200), p.report || '') });
    return json_({ ok: true, reports: publicReports_() });
  } catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'ข้อมูลไม่ถูกต้อง' }); }
  if (body.website) return json_({ ok: true }); // ช่องดักบอท (ผู้ใช้จริงไม่เห็นช่องนี้)
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (body.action === 'create') return json_(create_(body));
    if (body.action === 'close') return json_(close_(body));
    if (body.action === 'feedback') return json_(feedback_(body));
    return json_({ ok: false, error: 'ไม่รู้จักคำสั่ง' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally { try { lock.releaseLock(); } catch (e2) { /* ไม่ได้ถือ lock */ } }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ---------- การตรวจข้อมูล ----------
// ตัดช่องว่างก่อนแล้วค่อยตัดอักขระนำหน้าที่ทำให้ชีตตีความเป็นสูตร (= + - @)
function clean_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+\-@\s]+/, '').slice(0, max); }
function requireName_(s) {
  const n = clean_(s, 60);
  if (n.length < 2) throw new Error('กรุณากรอกชื่อ (อย่างน้อย 2 ตัวอักษร)');
  return n;
}
function device_(s) { return clean_(s, 64).replace(/[^\w-]/g, '') || 'unknown'; }
function rateLimit_(device) {
  const c = CacheService.getScriptCache();
  const k = 'rl_' + device;
  const n = Number(c.get(k) || 0);
  if (n >= CFG.RATE_LIMIT) throw new Error('แจ้งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
  // จำกัดรวมทั้งระบบด้วย (รหัสอุปกรณ์มาจากฝั่งผู้ใช้ ปลอมได้) กันการยิงอัปโหลดเข้า Drive ไม่จำกัด
  const g = Number(c.get('rl_all') || 0);
  if (g >= CFG.GLOBAL_LIMIT) throw new Error('ขณะนี้มีการแจ้งเข้ามามาก กรุณารอสักครู่แล้วลองใหม่');
  c.put(k, String(n + 1), 600);
  c.put('rl_all', String(g + 1), 600);
}
function saveFile_(f, allowed, maxBytes, prefix) {
  if (!f || !f.data) return '';
  const mime = String(f.type || '').toLowerCase();
  if (allowed.indexOf(mime) < 0) throw new Error('ชนิดไฟล์ไม่รองรับ: ' + mime);
  const bytes = Utilities.base64Decode(String(f.data).replace(/^data:[^,]+,/, ''));
  if (bytes.length > maxBytes) throw new Error('ไฟล์ใหญ่เกินกำหนด');
  const name = prefix + '_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 6);
  const file = folder_().createFile(Utilities.newBlob(bytes, mime, name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}
function videoLink_(s) {
  const u = clean_(s, 300);
  if (!u) return '';
  if (!/^https:\/\/([\w-]+\.)*(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|x\.com|twitter\.com|drive\.google\.com)\//i.test(u)) {
    throw new Error('ลิงก์วิดีโอต้องมาจาก YouTube, TikTok, Facebook, Instagram, X หรือ Google Drive');
  }
  return u;
}

// ---------- แจ้งน้ำท่วม ----------
function create_(b) {
  const name = requireName_(b.name);
  const device = device_(b.device);
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!(lat >= CFG.BBOX.s && lat <= CFG.BBOX.n && lng >= CFG.BBOX.w && lng <= CFG.BBOX.e)) throw new Error('ตำแหน่งต้องอยู่ในกรุงเทพมหานคร');
  if (!b.consent) throw new Error('กรุณายินยอมให้เผยแพร่ข้อมูลก่อนส่ง');
  rateLimit_(device);
  const level = LEVELS.indexOf(b.level) >= 0 ? b.level : 'ไม่ระบุ';
  const message = clean_(b.message, 500);
  const place = clean_(b.place, 120);
  const photos = (b.photos || []).slice(0, CFG.MAX_PHOTOS).map((f, i) => saveFile_(f, CFG.PHOTO_TYPES, CFG.MAX_PHOTO_BYTES, 'report_photo' + (i + 1))).filter(String);
  const video = saveFile_(b.video, CFG.VIDEO_TYPES, CFG.MAX_VIDEO_BYTES, 'report_video');
  const vlink = videoLink_(b.videoLink);

  const now = new Date();
  const id = 'R' + Utilities.formatDate(now, 'Asia/Bangkok', 'yyMMddHHmmss') + Utilities.getUuid().slice(0, 4).toUpperCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const row = {
    id, created_at: now.toISOString(), reporter_name: name, reporter_device: device, lat: round_(lat), lng: round_(lng), place, level, message,
    photo_ids: photos.join(','), video_id: video, video_link: vlink, status: 'open',
    closed_at: '', closed_by: '', closed_device: '', close_reason: '', close_photo_ids: '', updated_at: now.toISOString(),
  };
  ss.getSheetByName('Reports').appendRow(REPORT_HEADERS.map((h) => row[h]));
  appendLog_({ action: 'create', report_id: id, actor_name: name, actor_device: device, user_agent: clean_(b.ua, 200),
    lat: row.lat, lng: row.lng, level, message: (place ? '[' + place + '] ' : '') + message, photo_ids: row.photo_ids, video_id: video, video_link: vlink });
  return { ok: true, id, report: publicRow_(row) };
}

// ---------- น้ำลดแล้ว (เอาหมุดออก ไม่ลบข้อมูลจริง) ----------
function close_(b) {
  const name = requireName_(b.name);
  const device = device_(b.device);
  rateLimit_(device);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Reports');
  const found = findReport_(sh, clean_(b.id, 40));
  if (!found) throw new Error('ไม่พบรายงานนี้');
  if (found.row.status !== 'open') throw new Error('รายงานนี้ถูกปิดไปแล้ว');
  const reason = clean_(b.reason, 300);
  const photos = (b.photos || []).slice(0, 1).map((f) => saveFile_(f, CFG.PHOTO_TYPES, CFG.MAX_PHOTO_BYTES, 'close_photo')).filter(String);
  const now = new Date().toISOString();
  setFields_(sh, found.index, { status: 'closed', closed_at: now, closed_by: name, closed_device: device, close_reason: reason, close_photo_ids: photos.join(','), updated_at: now });
  appendLog_({ action: 'close', report_id: found.row.id, actor_name: name, actor_device: device, user_agent: clean_(b.ua, 200),
    lat: found.row.lat, lng: found.row.lng, message: reason, photo_ids: photos.join(',') });
  return { ok: true };
}

// ---------- เมนูแอดมินในชีต (ซ่อน/กู้คืนหมุด โดยมีบันทึกใน Log) ----------
// ---------- ข้อเสนอแนะจากหน้าเกี่ยวกับ ----------
function feedback_(b) {
  const device = device_(b.device);
  const c = CacheService.getScriptCache();
  const k = 'fb_' + device;
  if (Number(c.get(k) || 0) >= 3) throw new Error('ส่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
  const g = Number(c.get('fb_all') || 0);
  if (g >= CFG.FEEDBACK_GLOBAL_LIMIT) throw new Error('ขณะนี้มีข้อความเข้ามามาก กรุณาลองใหม่ภายหลัง');
  const name = requireName_(b.name);
  // ข้อความยาวเก็บบรรทัดใหม่ไว้ แต่ตัดอักขระควบคุมอื่นและกันสูตรในชีต
  const message = String(b.message == null ? '' : b.message).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().replace(/^[=+\-@\s]+/, '').slice(0, 3000);
  if (message.length < 5) throw new Error('กรุณาพิมพ์ข้อความ');
  const contact = clean_(b.contact, 120), topic = clean_(b.topic, 60) || 'ทั่วไป';
  c.put(k, String(Number(c.get(k) || 0) + 1), 3600);
  c.put('fb_all', String(g + 1), 3600);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, 'Feedback', FEEDBACK_HEADERS);
  const now = new Date().toISOString();
  let mailed = 'no';
  try {
    const mail = {
      to: Session.getEffectiveUser().getEmail(),
      subject: '[เว็บน้ำท่วม กทม.] ' + topic + ' — ' + name,
      body: 'ชื่อ: ' + name + '\nติดต่อกลับ: ' + (contact || '-') + '\nเรื่อง: ' + topic + '\nเวลา: ' + now + '\n\n' + message +
        '\n\n---\nส่งจาก ' + clean_(b.page, 200) + '\nบันทึกไว้ในชีต Feedback แล้ว',
    };
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) mail.replyTo = contact;
    MailApp.sendEmail(mail);
    mailed = 'yes';
  } catch (err) { mailed = 'error: ' + String(err.message || err).slice(0, 200); }
  sh.appendRow([now, name, contact, topic, message, device, clean_(b.page, 200), clean_(b.ua, 200), mailed]);
  return { ok: true };
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('น้ำท่วม (แอดมิน)')
    .addItem('ซ่อนรายงานในแถวที่เลือก', 'adminHide')
    .addItem('กู้คืนรายงานในแถวที่เลือก (เปิดหมุดอีกครั้ง)', 'adminRestore')
    .addItem('ตรวจสอบความถูกต้องของ Log', 'verifyLogUi')
    .addToUi();
}
function adminHide() { adminSet_('hidden', 'hide'); }
function adminRestore() { adminSet_('open', 'restore'); }
function adminSet_(status, action) {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== 'Reports') { ui.alert('กรุณาเลือกแถวในชีต Reports ก่อน'); return; }
  const r = sh.getActiveRange().getRow();
  if (r < 2) { ui.alert('กรุณาเลือกแถวรายงาน'); return; }
  const reason = ui.prompt('เหตุผล (จะบันทึกใน Log)').getResponseText();
  const row = rowObj_(sh.getRange(r, 1, 1, REPORT_HEADERS.length).getValues()[0]);
  const admin = Session.getActiveUser().getEmail() || 'admin';
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    setFields_(sh, r, { status, updated_at: new Date().toISOString() });
    appendLog_({ action, report_id: row.id, actor_name: 'แอดมิน: ' + admin, actor_device: 'sheet', lat: row.lat, lng: row.lng, message: clean_(reason, 300) });
  } finally { lock.releaseLock(); }
  ui.alert((action === 'hide' ? 'ซ่อน' : 'กู้คืน') + ' ' + row.id + ' แล้ว');
}

// ---------- Log แบบต่อท้าย + hash chain ----------
function appendLog_(o) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  const last = sh.getLastRow();
  const prev = last >= 2 ? String(sh.getRange(last, LOG_HEADERS.length).getValue()) : 'GENESIS';
  const rec = { log_id: 'L' + (last).toString().padStart(6, '0'), timestamp: new Date().toISOString(), prev_hash: prev };
  LOG_HEADERS.forEach((h) => { if (!(h in rec) && h !== 'hash') rec[h] = o[h] == null ? '' : o[h]; });
  rec.hash = sha256_(prev + '|' + LOG_HEADERS.slice(0, -2).map((h) => String(rec[h])).join('|'));
  sh.appendRow(LOG_HEADERS.map((h) => rec[h]));
  return rec;
}
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}
function verifyLog() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  const rows = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues() : [];
  let prev = 'GENESIS';
  for (let i = 0; i < rows.length; i++) {
    const r = rowObjLog_(rows[i]);
    const expect = sha256_(prev + '|' + LOG_HEADERS.slice(0, -2).map((h) => String(r[h])).join('|'));
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, row: i + 2, log_id: r.log_id };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}
function verifyLogUi() {
  const r = verifyLog();
  SpreadsheetApp.getUi().alert(r.ok ? `Log ถูกต้องครบ ${r.rows} แถว ไม่มีการแก้ไข` : `พบการแก้ไข Log ที่แถว ${r.row} (${r.log_id}) หรือแถวก่อนหน้า`);
}

// ---------- อ่านข้อมูลสำหรับเว็บ (ชื่อแบบย่อ ไม่มีรหัสอุปกรณ์) ----------
function maskName_(n) {
  const parts = String(n || '').trim().split(/\s+/).filter(String);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].length <= 2 ? parts[0][0] + '*' : parts[0].slice(0, 2) + '***';
  return parts[0] + ' ' + parts[1][0] + '.';
}
function photoUrls_(ids) { return String(ids || '').split(',').filter(String).map((id) => 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000'); }
function publicRow_(r) {
  return {
    id: r.id, created_at: iso_(r.created_at), reporter: maskName_(r.reporter_name), lat: Number(r.lat), lng: Number(r.lng), place: r.place,
    level: r.level, message: r.message, photos: photoUrls_(r.photo_ids),
    video: r.video_id ? 'https://drive.google.com/file/d/' + r.video_id + '/preview' : '', video_link: r.video_link, status: r.status,
    closed_at: iso_(r.closed_at), closed_by: maskName_(r.closed_by), close_reason: r.close_reason, close_photos: photoUrls_(r.close_photo_ids),
  };
}
function publicReports_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Reports');
  if (sh.getLastRow() < 2) return [];
  const cutoff = Date.now() - CFG.CLOSED_VISIBLE_H * 36e5;
  return sh.getRange(2, 1, sh.getLastRow() - 1, REPORT_HEADERS.length).getValues().map(rowObj_)
    .filter((r) => r.status === 'open' || (r.status === 'closed' && new Date(r.closed_at).getTime() >= cutoff))
    .map(publicRow_);
}
function publicLog_(limit, reportId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  if (sh.getLastRow() < 2) return [];
  const n = sh.getLastRow() - 1;
  let rows = sh.getRange(2, 1, n, LOG_HEADERS.length).getValues().map((v) => rowObjLog_(v));
  if (reportId) rows = rows.filter((r) => r.report_id === reportId);
  return rows.slice(-limit).reverse().map((r) => ({
    log_id: r.log_id, timestamp: iso_(r.timestamp), action: r.action, report_id: r.report_id,
    actor: String(r.actor_name).indexOf('แอดมิน') === 0 ? 'แอดมิน' : maskName_(r.actor_name),
    level: r.level, message: r.message, photos: photoUrls_(r.photo_ids),
    video: r.video_id ? 'https://drive.google.com/file/d/' + r.video_id + '/preview' : '', video_link: r.video_link, hash: String(r.hash).slice(0, 12),
  }));
}

// ---------- helpers ----------
function rowObj_(v) { const o = {}; REPORT_HEADERS.forEach((h, i) => { o[h] = v[i]; }); return o; }
function rowObjLog_(v) { const o = {}; LOG_HEADERS.forEach((h, i) => { o[h] = v[i]; }); return o; }
function findReport_(sh, id) {
  if (!id || sh.getLastRow() < 2) return null;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) {
    return { index: i + 2, row: rowObj_(sh.getRange(i + 2, 1, 1, REPORT_HEADERS.length).getValues()[0]) };
  }
  return null;
}
function setFields_(sh, rowIndex, fields) {
  Object.keys(fields).forEach((k) => sh.getRange(rowIndex, REPORT_HEADERS.indexOf(k) + 1).setValue(fields[k]));
}
function iso_(v) { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? String(v) : d.toISOString(); }
function round_(x) { return Math.round(x * 1e5) / 1e5; }
