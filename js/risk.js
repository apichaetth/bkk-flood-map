/* หน้าประมาณการถนนเสี่ยงน้ำท่วม (ทดลอง): อ่าน data/risk-roads.json ที่ GitHub Actions คำนวณทุก 15 นาที */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT, cssVar } = F;
  const NAME = { 3: 'แนวโน้มสูง', 2: 'แนวโน้มกลาง', 1: 'เฝ้าระวัง' };
  const COLOR = () => ({ 3: cssVar('--rk3'), 2: cssVar('--rk2'), 1: cssVar('--rk1') });
  const show = { 1: true, 2: true, 3: true };
  let data = null, fitted = false;

  const map = L.map('rmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 18 }).setView([13.75, 100.56], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  F.addLocate(map, () => { fitted = true; });
  const layer = L.layerGroup().addTo(map);

  function draw() {
    layer.clearLayers();
    if (!data) return;
    const col = COLOR();
    // ระดับต่ำวาดก่อน ให้ระดับสูงอยู่ด้านบน
    const segs = data.segments.filter((s) => show[s.tier]).sort((a, b) => a.tier - b.tier);
    for (const s of segs) {
      const pop = `<div class="pp"><span class="badge" style="--c:${col[s.tier]}">${NAME[s.tier]}</span> <span class="m">คะแนน ${(s.score * 100).toFixed(0)}/100</span>
        <h3>${esc(s.name || 'ถนนไม่มีชื่อ')}</h3><div class="m">เขต${esc(s.district)}</div>
        <ul class="plist">${s.why.map((w) => `<li>${esc(w)}</li>`).join('') || '<li>คะแนนรวมจากหลายปัจจัยเล็กน้อย</li>'}</ul>
        <div class="m">ประมาณการ ไม่ใช่การยืนยัน</div></div>`;
      L.polyline(s.c, { color: '#fff', weight: s.tier === 3 ? 11 : 9, opacity: 0.85, lineCap: 'round', interactive: false }).addTo(layer);
      L.polyline(s.c, { color: col[s.tier], weight: s.tier === 3 ? 7 : s.tier === 2 ? 6 : 5, opacity: 1, dashArray: s.tier === 1 ? '8 6' : null, lineCap: 'round' }).bindPopup(pop, { maxWidth: 320 }).addTo(layer);
    }
    if (!fitted && segs.length) { map.fitBounds(L.latLngBounds(segs.flatMap((s) => s.c)).pad(0.1), { maxZoom: 14 }); fitted = true; }
  }
  function renderSide() {
    const c = data.counts || {};
    $('n3').textContent = c[3] || 0; $('n2').textContent = c[2] || 0; $('n1').textContent = c[1] || 0;
    // รวมตามชื่อถนน + เขต
    const byRoad = new Map();
    for (const s of data.segments) {
      const k = (s.name || 'ถนนไม่มีชื่อ') + '|' + s.district;
      const r = byRoad.get(k) || { name: s.name || 'ถนนไม่มีชื่อ', district: s.district, tier: 0, score: 0, n: 0, s };
      r.n++; if (s.score > r.score) { r.score = s.score; r.tier = s.tier; r.s = s; }
      byRoad.set(k, r);
    }
    const col = COLOR();
    const top = [...byRoad.values()].sort((a, b) => b.tier - a.tier || b.score - a.score).slice(0, 15);
    $('roads').innerHTML = top.length ? top.map((r, i) => `<li><a href="#" data-i="${i}"><span class="tagx" style="background:${col[r.tier]}">${NAME[r.tier]}</span><b>${esc(r.name)}</b> <span class="muted small">เขต${esc(r.district)} · ${r.n} ช่วง</span></a></li>`).join('')
      : '<li class="muted">ตอนนี้ไม่มีถนนที่มีแนวโน้มน้ำท่วม</li>';
    $('roads').querySelectorAll('a').forEach((a) => a.onclick = (e) => {
      e.preventDefault(); const s = top[+a.dataset.i].s;
      map.setView([s.la, s.lo], 16); $('rmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // วัดผล
    const a = data.accuracy || {};
    const hi = a.precision && a.precision['สูง'];
    $('acc').textContent = hi && hi.pct != null ? hi.pct + '%' : '–';
    $('accSub').textContent = a.runs ? `(${a.runs} รอบ)` : '(รอข้อมูล)';
    $('evalBox').innerHTML = a.runs ? `<div class="rk-eval"><p class="muted small">จากการทาย ${a.runs} รอบที่ผ่านมา (ครบ ${a.horizonH} ชม. แล้ว) นับว่า "ถูก" เมื่อมีรายงานน้ำท่วมใหม่ในรัศมี ${a.hitM} ม. ภายใน ${a.horizonH} ชม.</p>
      <table><thead><tr><th>ระดับที่ทาย</th><th class="n">ช่วงถนนที่ทาย</th><th class="n">มีรายงานจริง</th><th class="n">ทายถูก</th></tr></thead><tbody>
      ${Object.entries(a.precision).reverse().map(([k, v]) => `<tr><td>${esc(k === 'สูง' ? 'แนวโน้มสูง' : k === 'กลาง' ? 'แนวโน้มกลาง' : k)}</td><td class="n">${v.predicted}</td><td class="n">${v.hit}</td><td class="n">${v.pct != null ? v.pct + '%' : '–'}</td></tr>`).join('')}
      </tbody></table>
      <p class="small" style="margin-top:8px">รายงานน้ำท่วมใหม่ที่เกิดขึ้น <b>${a.recall.newReports}</b> ครั้ง อยู่บนถนนที่ทายไว้ล่วงหน้า <b>${a.recall.caught}</b> ครั้ง (${a.recall.pct != null ? a.recall.pct + '%' : '–'})</p></div>`
      : '<p class="muted">ต้องรอผลการทายอย่างน้อย 3 ชม. แรกก่อน จึงจะเริ่มวัดความแม่นได้</p>';
  }
  async function load() {
    $('updated').textContent = 'กำลังโหลด…';
    try {
      data = await F.getJSON('data/risk-roads.json?t=' + Date.now(), 45000);
      draw(); renderSide();
      const src = data.sources || {};
      const bad = Object.entries(src).filter(([, v]) => typeof v === 'string' && v.startsWith('error')).map(([k]) => k);
      $('updated').textContent = `คำนวณเมื่อ ${fmtDT(new Date(data.updated))} · จากถนน ${data.roadSegments.toLocaleString()} ช่วง${bad.length ? ` · ข้อมูลบางแหล่งใช้ไม่ได้รอบนี้: ${bad.join(', ')}` : ''} · อัปเดตทุก 15 นาที`;
    } catch (e) {
      $('updated').textContent = 'ยังไม่มีผลการคำนวณ (' + e.message + ') ระบบจะคำนวณในรอบอัปเดตถัดไป';
    }
  }
  document.querySelectorAll('.rk-filter input').forEach((i) => i.onchange = () => { show[i.dataset.t] = i.checked; draw(); });
  $('refresh').onclick = load;
  setInterval(load, F.REFRESH_MS);
  load();
})();
