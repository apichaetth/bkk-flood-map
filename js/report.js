/* ระบบให้ประชาชนปักหมุดแจ้งน้ำท่วม และแจ้งว่าน้ำลดแล้ว (เอาหมุดออก)
 * ข้อมูลเก็บใน Google Sheets ผ่าน Google Apps Script (ดู apps-script/) ทุกการกระทำถูกบันทึกใน Log
 */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT, ago, badge } = F;
  const M = window.FloodMap;
  if (!M) return;
  const { map, layers, setFeed, icon } = M;

  const LEVELS = ['ข้อเท้า', 'ครึ่งแข้ง', 'เข่า', 'เอว', 'สูงกว่าเอว', 'ไม่ระบุ'];
  const MAX_PHOTOS = 3, PHOTO_MAX_PX = 1280, VIDEO_MAX_MB = 15, VIDEO_MAX_S = 20;
  const NAME_KEY = 'bkkflood.reporterName';
  let endpoint = '';
  let reports = [];

  // ---------- โหลดและวาดหมุด ----------
  async function load() {
    setFeed('web', 'loading');
    try {
      const r = await F.fetchWebReports();
      reports = r.items;
      setFeed('web', 'ok', r.msg, r.newest);
    } catch (e) { reports = []; setFeed('web', 'fail', e.message); }
    draw();
  }
  function media(r) {
    const ph = (r.photos || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(u)}" alt="ภาพจากผู้แจ้ง" referrerpolicy="no-referrer"></a>`).join('');
    const vid = r.video ? `<iframe class="drv" src="${esc(r.video)}" allow="autoplay" loading="lazy" title="วิดีโอจากผู้แจ้ง"></iframe>` : '';
    const link = r.video_link ? `<a href="${esc(r.video_link)}" target="_blank" rel="noopener">▶ ดูวิดีโอ</a>` : '';
    return `${ph ? `<div class="ph3">${ph}</div>` : ''}${vid}${link}`;
  }
  function draw() {
    layers.web.clearLayers();
    for (const x of reports) {
      const r = x.r;
      const html = `<div class="pp">${badge(x.lv, 'น้ำระดับ' + r.level)} <span class="m">ประชาชนแจ้งผ่านเว็บนี้ · ยังไม่ยืนยัน</span>
        ${r.place ? `<h3>${esc(r.place)}</h3>` : ''}
        ${r.message ? `<div style="margin-top:4px">${esc(r.message)}</div>` : ''}
        ${media(r)}
        <div class="m" style="margin-top:6px">แจ้งโดย ${esc(r.reporter)} · ${fmtDT(x.t)} (${ago(x.t)})<br>
        <a href="log.html?report=${encodeURIComponent(r.id)}">ประวัติของหมุดนี้ (${esc(r.id)})</a></div>
        <button type="button" class="btn close-btn" data-id="${esc(r.id)}">✔ น้ำลดแล้ว / เอาหมุดออก</button></div>`;
      L.marker([x.la, x.lo], { icon: icon('web', F.LEVEL[x.lv].color, '!', 18, F.LEVEL[x.lv].dark ? 'dark' : ''), zIndexOffset: 900 })
        .bindPopup(html, { maxWidth: 320, minWidth: 240 })
        .on('popupopen', (e) => { const b = e.popup.getElement().querySelector('.close-btn'); if (b) b.onclick = () => openClose(r); })
        .addTo(layers.web);
    }
  }

  // ---------- ปุ่มแจ้ง + โหมดปักหมุด ----------
  const fab = document.createElement('div');
  fab.className = 'report-fab';
  fab.innerHTML = '<button type="button" id="rpStart" class="btn primary">📍 แจ้งน้ำท่วม</button>';
  $('map').appendChild(fab);
  L.DomEvent.disableClickPropagation(fab);
  const bar = document.createElement('div');
  bar.className = 'pick-bar'; bar.hidden = true;
  bar.innerHTML = `<span>แตะบนแผนที่ตรงจุดที่น้ำท่วม</span>
    <button type="button" class="btn" id="rpGps">ใช้ตำแหน่งปัจจุบัน</button><button type="button" class="btn" id="rpCancel">ยกเลิก</button>`;
  $('map').appendChild(bar);
  L.DomEvent.disableClickPropagation(bar);

  let picking = false, tempMarker = null;
  function startPick() {
    if (!endpoint) { alert('ระบบแจ้งน้ำท่วมยังไม่เปิดใช้งาน'); return; }
    picking = true; bar.hidden = false; fab.hidden = true;
    map.getContainer().classList.add('picking');
    if (M.minimizePanel) M.minimizePanel();
  }
  function stopPick() {
    picking = false; bar.hidden = true; fab.hidden = false;
    map.getContainer().classList.remove('picking');
  }
  function picked(latlng) {
    if (!F.inBkk(latlng.lat, latlng.lng)) { alert('ตำแหน่งต้องอยู่ในกรุงเทพมหานคร'); return; }
    stopPick();
    if (tempMarker) tempMarker.remove();
    tempMarker = L.marker(latlng, { icon: icon('web', 'var(--critical)', '?', 22) }).addTo(map);
    map.setView(latlng, Math.max(map.getZoom(), 16));
    openCreate(latlng);
  }
  map.on('click', (e) => { if (picking) picked(e.latlng); });
  $('rpStart').onclick = startPick;
  $('rpCancel').onclick = stopPick;
  $('rpGps').onclick = () => {
    if (!navigator.geolocation) { alert('อุปกรณ์นี้ไม่รองรับการหาตำแหน่ง'); return; }
    $('rpGps').textContent = 'กำลังหาตำแหน่ง…';
    navigator.geolocation.getCurrentPosition(
      (p) => { $('rpGps').textContent = 'ใช้ตำแหน่งปัจจุบัน'; picked(L.latLng(p.coords.latitude, p.coords.longitude)); },
      () => { $('rpGps').textContent = 'ใช้ตำแหน่งปัจจุบัน'; alert('หาตำแหน่งไม่ได้ กรุณาแตะบนแผนที่แทน'); },
      { enableHighAccuracy: true, timeout: 15000 });
  };

  // ---------- ไฟล์: ย่อรูป / ตรวจวิดีโอ ----------
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) throw new Error('เปิดรูป ' + file.name + ' ไม่ได้ (ลองใช้ไฟล์ JPG/PNG)');
    const k = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return { type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.72) };
  }
  function readVideo(file) {
    return new Promise((res, rej) => {
      if (file.size > VIDEO_MAX_MB * 1024 * 1024) return rej(new Error(`วิดีโอต้องไม่เกิน ${VIDEO_MAX_MB} MB`));
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        if (v.duration > VIDEO_MAX_S + 0.5) return rej(new Error(`วิดีโอต้องยาวไม่เกิน ${VIDEO_MAX_S} วินาที`));
        const fr = new FileReader();
        fr.onload = () => res({ type: file.type || 'video/mp4', data: fr.result });
        fr.onerror = () => rej(new Error('อ่านไฟล์วิดีโอไม่ได้'));
        fr.readAsDataURL(file);
      };
      v.onerror = () => { URL.revokeObjectURL(url); rej(new Error('เปิดไฟล์วิดีโอไม่ได้')); };
      v.src = url;
    });
  }

  // ---------- ฟอร์ม ----------
  const dlg = document.createElement('dialog');
  dlg.className = 'rp-dialog';
  document.body.appendChild(dlg);
  const savedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } };
  const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* ไม่เป็นไร */ } };

  function openCreate(latlng) {
    dlg.innerHTML = `<form method="dialog" class="rp-form" novalidate>
      <h2>📍 แจ้งน้ำท่วม</h2>
      <p class="muted small">ตำแหน่ง ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)} · <a href="#" id="rpRepick">เลือกตำแหน่งใหม่</a></p>
      <label>ชื่อผู้แจ้ง <b class="req">*</b><input name="name" required maxlength="60" autocomplete="name" value="${esc(savedName())}" placeholder="เช่น สมชาย ใจดี"></label>
      <label>สถานที่ (ถ้ามี)<input name="place" maxlength="120" placeholder="เช่น หน้าซอยลาดพร้าว 71"></label>
      <fieldset><legend>ระดับน้ำ</legend><div class="lv">${LEVELS.map((l, i) => `<label><input type="radio" name="level" value="${l}"${i === 5 ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <label>รายละเอียด<textarea name="message" rows="3" maxlength="500" placeholder="เช่น รถเล็กผ่านไม่ได้ น้ำยังไม่ลด"></textarea></label>
      <label>รูปภาพ (ไม่บังคับ สูงสุด ${MAX_PHOTOS} รูป ระบบย่อให้อัตโนมัติ)<input name="photos" type="file" accept="image/*" multiple></label>
      <label>วิดีโอสั้น (ไม่บังคับ ≤ ${VIDEO_MAX_S} วินาที, ${VIDEO_MAX_MB} MB)<input name="video" type="file" accept="video/*"></label>
      <label>หรือวางลิงก์วิดีโอ (YouTube / TikTok / Facebook / Instagram / X)<input name="videoLink" type="url" placeholder="https://"></label>
      <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label class="consent"><input type="checkbox" name="consent"> ยินยอมให้เผยแพร่ตำแหน่ง ข้อความ รูป/วิดีโอ และชื่อแบบย่อ (เช่น "สมชาย ใ.") บนเว็บนี้ ชื่อเต็มเก็บไว้ใน Log ที่ผู้ดูแลเห็นเท่านั้น</label>
      <p class="rp-msg" role="status"></p>
      <div class="rp-actions"><button type="button" class="btn" value="cancel">ยกเลิก</button><button type="submit" class="btn primary">ส่งรายงาน</button></div>
    </form>`;
    const f = dlg.querySelector('form');
    const msg = f.querySelector('.rp-msg');
    f.querySelector('[value=cancel]').onclick = () => { dlg.close(); if (tempMarker) tempMarker.remove(); };
    f.querySelector('#rpRepick').onclick = (e) => { e.preventDefault(); dlg.close(); if (tempMarker) tempMarker.remove(); startPick(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const name = String(fd.get('name') || '').trim();
      if (name.length < 2) { msg.textContent = 'กรุณากรอกชื่อ'; return; }
      if (!fd.get('consent')) { msg.textContent = 'กรุณากดยินยอมก่อนส่ง'; return; }
      const btn = f.querySelector('[type=submit]'); btn.disabled = true;
      try {
        msg.textContent = 'กำลังเตรียมไฟล์…';
        const photos = [];
        for (const file of [...f.photos.files].slice(0, MAX_PHOTOS)) photos.push(await shrinkImage(file));
        const video = f.video.files[0] ? await readVideo(f.video.files[0]) : null;
        msg.textContent = 'กำลังส่ง…';
        saveName(name);
        const res = await send({
          action: 'create', name, device: F.deviceId(), ua: navigator.userAgent, lat: latlng.lat, lng: latlng.lng,
          place: fd.get('place'), level: fd.get('level'), message: fd.get('message'), photos, video,
          videoLink: fd.get('videoLink'), consent: true, website: fd.get('website'),
        });
        msg.textContent = `ส่งแล้ว ขอบคุณครับ (รหัส ${res.id})`;
        if (tempMarker) tempMarker.remove();
        setTimeout(() => dlg.close(), 1200);
        load();
      } catch (err) { msg.textContent = 'ส่งไม่สำเร็จ: ' + err.message; btn.disabled = false; }
    };
    dlg.showModal();
  }

  function openClose(r) {
    map.closePopup();
    dlg.innerHTML = `<form method="dialog" class="rp-form" novalidate>
      <h2>✔ แจ้งว่าน้ำลดแล้ว</h2>
      <p class="muted small">หมุด ${esc(r.id)}${r.place ? ' · ' + esc(r.place) : ''} จะถูกเอาออกจากแผนที่ แต่ข้อมูลยังเก็บไว้ในบันทึก (Log) ทั้งหมด</p>
      <label>ชื่อผู้แจ้ง <b class="req">*</b><input name="name" required maxlength="60" value="${esc(savedName())}"></label>
      <label>เหตุผล / รายละเอียด (ไม่บังคับ)<textarea name="reason" rows="2" maxlength="300" placeholder="เช่น น้ำลดหมดแล้ว รถผ่านได้ปกติ"></textarea></label>
      <label>รูปยืนยัน (ไม่บังคับ)<input name="photo" type="file" accept="image/*"></label>
      <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p class="rp-msg" role="status"></p>
      <div class="rp-actions"><button type="button" class="btn" value="cancel">ยกเลิก</button><button type="submit" class="btn primary">ยืนยัน น้ำลดแล้ว</button></div>
    </form>`;
    const f = dlg.querySelector('form');
    const msg = f.querySelector('.rp-msg');
    f.querySelector('[value=cancel]').onclick = () => dlg.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const name = String(fd.get('name') || '').trim();
      if (name.length < 2) { msg.textContent = 'กรุณากรอกชื่อ'; return; }
      const btn = f.querySelector('[type=submit]'); btn.disabled = true;
      try {
        msg.textContent = 'กำลังส่ง…';
        const photos = f.photo.files[0] ? [await shrinkImage(f.photo.files[0])] : [];
        saveName(name);
        await send({ action: 'close', id: r.id, name, device: F.deviceId(), ua: navigator.userAgent, reason: fd.get('reason'), photos, website: fd.get('website') });
        msg.textContent = 'บันทึกแล้ว ขอบคุณครับ';
        setTimeout(() => dlg.close(), 900);
        load();
      } catch (err) { msg.textContent = 'ส่งไม่สำเร็จ: ' + err.message; btn.disabled = false; }
    };
    dlg.showModal();
  }

  async function send(payload) {
    // text/plain เพื่อไม่ให้เบราว์เซอร์ต้องทำ CORS preflight กับ Apps Script
    const res = await F.getJSON(endpoint, 120000, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    if (!res.ok) throw new Error(res.error || 'ไม่ทราบสาเหตุ');
    return res;
  }

  // ---------- เริ่มทำงาน ----------
  F.reportEndpoint().then((ep) => {
    endpoint = ep;
    if (!ep) { fab.querySelector('button').title = 'ระบบแจ้งยังไม่เปิดใช้งาน'; fab.classList.add('off'); }
    load();
    if (new URLSearchParams(location.search).get('report') === '1' && ep) startPick();
  });
  $('refresh').addEventListener('click', load);
  setInterval(load, F.REFRESH_MS);
})();
