// หน้าเกี่ยวกับ: ส่งข้อเสนอแนะไปที่ Apps Script (action: feedback) ซึ่งจะส่งอีเมลถึงผู้จัดทำ
(function () {
  const F = window.Flood;
  const form = F.$('fb'), msg = F.$('fbMsg'), send = F.$('fbSend');
  const say = (t, ok) => { msg.textContent = t; msg.style.color = ok ? 'var(--good)' : ''; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (String(d.name || '').trim().length < 2) { say('กรุณากรอกชื่อ'); form.elements.name.focus(); return; }
    if (String(d.message || '').trim().length < 5) { say('กรุณาพิมพ์ข้อความ'); form.elements.message.focus(); return; }
    const ep = await F.reportEndpoint();
    if (!ep) { say('ระบบส่งข้อความยังไม่เปิดใช้งาน'); return; }
    send.disabled = true; say('กำลังส่ง…', true);
    try {
      // text/plain เพื่อไม่ให้เบราว์เซอร์ต้องทำ CORS preflight กับ Apps Script
      const r = await F.getJSON(ep, 30000, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'feedback', ...d, device: F.deviceId(), page: location.href, ua: navigator.userAgent }),
      });
      if (!r.ok) throw new Error(r.error || 'ส่งไม่สำเร็จ');
      form.reset();
      say('ส่งข้อความแล้ว ขอบคุณครับ', true);
    } catch (err) {
      say('ส่งไม่สำเร็จ: ' + (err.message || 'เชื่อมต่อไม่ได้'));
    } finally { send.disabled = false; }
  });
})();
