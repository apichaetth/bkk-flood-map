/* หน้าบันทึกการแจ้ง: อ่าน log (ชื่อแบบย่อ) จาก Google Apps Script */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT } = F;
  const ACT = { create: ['แจ้งน้ำท่วม', 't3'], close: ['น้ำลดแล้ว', 'ok'], hide: ['ผู้ดูแลซ่อน', 't1'], restore: ['ผู้ดูแลกู้คืน', 't2'] };
  const report = new URLSearchParams(location.search).get('report') || '';
  let rows = [];

  function render() {
    const q = $('q').value.trim().toLowerCase(), act = $('act').value;
    const list = rows.filter((r) => (!act || r.action === act) && (!q || [r.actor, r.report_id, r.message].join(' ').toLowerCase().includes(q)));
    $('rows').innerHTML = list.length ? list.map((r) => {
      const a = ACT[r.action] || [r.action, ''];
      const media = [...(r.photos || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(u)}" alt="รูป" referrerpolicy="no-referrer"></a>`),
        r.video ? `<a href="${esc(r.video)}" target="_blank" rel="noopener">▶ วิดีโอ</a>` : '', r.video_link ? `<a href="${esc(r.video_link)}" target="_blank" rel="noopener">▶ ลิงก์</a>` : ''].join(' ');
      return `<tr><td data-l="เวลา">${fmtDT(new Date(r.timestamp))}</td><td data-l="การกระทำ"><span class="tag ${a[1]}">${a[0]}</span></td>
        <td data-l="หมุด"><a href="log.html?report=${encodeURIComponent(r.report_id)}">${esc(r.report_id)}</a></td><td data-l="ผู้ทำ">${esc(r.actor)}</td>
        <td data-l="ข้อความ">${r.level && r.action === 'create' ? `<b>น้ำระดับ${esc(r.level)}</b> ` : ''}${esc(r.message)}</td><td data-l="รูป/วิดีโอ" class="thumbs">${media}</td><td data-l="hash"><code>${esc(r.hash)}</code></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="muted">ยังไม่มีบันทึก</td></tr>';
  }
  async function load() {
    $('updated').textContent = 'กำลังโหลด…';
    const ep = await F.reportEndpoint();
    if (!ep) { $('rows').innerHTML = '<tr><td colspan="7" class="muted">ระบบแจ้งน้ำท่วมยังไม่เปิดใช้งาน</td></tr>'; $('updated').textContent = ''; return; }
    try {
      const d = await F.getJSON(ep + '?action=log&limit=500' + (report ? '&report=' + encodeURIComponent(report) : '') + '&t=' + Date.now(), 30000);
      if (!d.ok) throw new Error(d.error || 'อ่านบันทึกไม่ได้');
      rows = d.log || [];
      render();
      $('updated').textContent = `อัปเดต ${fmtDT(new Date())} · ${rows.length} รายการ`;
    } catch (e) { $('rows').innerHTML = `<tr><td colspan="7">โหลดไม่สำเร็จ: ${esc(e.message)}</td></tr>`; }
  }
  if (report) { $('title').textContent = 'ประวัติของหมุด ' + report; $('all').hidden = false; }
  $('q').oninput = render; $('act').onchange = render; $('refresh').onclick = load;
  load();
})();
