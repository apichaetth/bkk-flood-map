/* หน้าประมาณการถนนเสี่ยงน้ำท่วม (ทดลอง): อ่าน data/risk-roads.json ที่ GitHub Actions คำนวณทุก 15 นาที */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT, cssVar } = F;
  const NAME = { 3: 'แนวโน้มสูง', 2: 'แนวโน้มกลาง', 1: 'เฝ้าระวัง' };
  const COLOR = () => ({ 3: cssVar('--rk3'), 2: cssVar('--rk2'), 1: cssVar('--rk1') });
  const show = { 1: true, 2: true, 3: true };
  const SRC = ['หน่วยงาน/iTIC', 'Traffy', 'ประชาชนปักหมุด', 'ข่าว'];
  // ไฟล์รูปแบบกะทัดรัด (v2): ถอดพิกัดแบบผลต่าง และสร้างข้อความเหตุผลจากตัวเลข
  function unpack(d) {
    if (d.v !== 2) return d;
    const segments = d.s.map(([tier, sc, n, di, flat, x]) => {
      const c = []; let a = 0, o = 0;
      for (let i = 0; i < flat.length; i += 2) { a += flat[i]; o += flat[i + 1]; c.push([a / 1e5, o / 1e5]); }
      const m = c[Math.floor(c.length / 2)];
      return { tier, score: sc / 100, name: d.names[n], district: d.districts[di], c, la: m[0], lo: m[1], x, stations: d.stations };
    });
    return { ...d, segments };
  }
  function whyOf(s) {
    if (s.why) return s.why;
    const [src, dist, age, mm1, mm24, hc, pct, st] = s.x, w = [];
    if (src >= 0) w.push(`มีรายงานน้ำท่วม (${SRC[src]}) ห่าง ${dist} ม. เมื่อ ${age} นาทีที่แล้ว`);
    if (mm1 >= 0) w.push(`ฝนแถวนี้ประมาณ ${mm1} มม./ชม. · ${mm24} มม./24 ชม.`);
    if (hc) w.push(`เคยมีคนแจ้งน้ำท่วมแถวนี้ ${hc} ครั้งในช่วงที่ผ่านมา`);
    if (pct >= 0) w.push(`ระดับน้ำ${st >= 0 ? ' ' + s.stations[st] : ''} ${pct}% ของตลิ่ง`);
    return w;
  }
  let data = null, fitted = false;

  // วาดด้วย canvas: ถนนหลายพันช่วง SVG จะช้ามาก
  const map = L.map('rmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 18, preferCanvas: true, renderer: L.canvas({ tolerance: 6 }) }).setView([13.75, 100.56], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  F.addLocate(map, () => { fitted = true; });
  const layer = L.layerGroup().addTo(map);

  function draw() {
    layer.clearLayers();
    if (!data) return;
    const col = COLOR();
    // ระดับต่ำวาดก่อน ให้ระดับสูงอยู่ด้านบน
    const segs = data.segments.filter((s) => show[s.tier]).sort((a, b) => a.tier - b.tier);
    // เส้นขอบขาวเฉพาะระดับกลาง/สูง ส่วนป๊อปอัปสร้างตอนกดเท่านั้น
    const pop = (s) => `<div class="pp"><span class="badge" style="--c:${col[s.tier]}">${NAME[s.tier]}</span> <span class="m">คะแนน ${(s.score * 100).toFixed(0)}/100</span>
        <h3>${esc(s.name || 'ถนนไม่มีชื่อ')}</h3><div class="m">เขต${esc(s.district)}</div>
        <ul class="plist">${whyOf(s).map((w) => `<li>${esc(w)}</li>`).join('') || '<li>คะแนนรวมจากหลายปัจจัยเล็กน้อย</li>'}</ul>
        <div class="m">ประมาณการ ไม่ใช่การยืนยัน</div></div>`;
    for (const s of segs) {
      if (s.tier > 1) L.polyline(s.c, { color: '#fff', weight: s.tier === 3 ? 11 : 9, opacity: 0.85, lineCap: 'round', interactive: false }).addTo(layer);
      L.polyline(s.c, { color: col[s.tier], weight: s.tier === 3 ? 7 : s.tier === 2 ? 6 : 4, opacity: s.tier === 1 ? 0.8 : 1, dashArray: s.tier === 1 ? '8 6' : null, lineCap: 'round' })
        .bindPopup(() => pop(s), { maxWidth: 320 }).addTo(layer);
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
  // แสดงผลทันที: ผลรอบก่อนที่เก็บในเครื่อง แล้วค่อยแทนด้วยไฟล์ล่าสุด
  const CACHE = 'risk-cache-v2';
  try { localStorage.removeItem('risk-lite-cache'); } catch (e) { /* ไม่เป็นไร */ }
  const status = $('rkStatus');
  const note = (t) => { status.textContent = t; status.hidden = !t; };
  function show1(d, label) {
    data = unpack(d); draw(); renderSide();
    d = data;
    const src = d.sources || {};
    const bad = Object.entries(src).filter(([, v]) => typeof v === 'string' && v.startsWith('error')).map(([k]) => k);
    $('updated').textContent = `คำนวณเมื่อ ${fmtDT(new Date(d.updated))} · จากถนน ${d.roadSegments.toLocaleString()} ช่วง${bad.length ? ` · ข้อมูลบางแหล่งใช้ไม่ได้รอบนี้: ${bad.join(', ')}` : ''} · อัปเดตทุก 15 นาที`;
    note(label);
  }
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    if (!data) {
      const c = F.store.get(CACHE);
      if (c && c.s) show1(c, `แสดงผลรอบก่อน (${fmtDT(new Date(c.updated))}) ระหว่างโหลดข้อมูลล่าสุด…`);
      else note('กำลังโหลดข้อมูลถนนเสี่ยง…');
    }
    try {
      // no-cache = ถามเซิร์ฟเวอร์ว่าไฟล์เปลี่ยนไหม ถ้าไม่เปลี่ยนได้ 304 ใช้ของในเครื่องได้เลย
      const d = await F.getJSON('data/risk-roads.json', 60000, { cache: 'no-cache' });
      show1(d, '');
      if (d.v === 2) F.store.set(CACHE, d);
    } catch (e) {
      if (data) note('โหลดข้อมูลล่าสุดไม่สำเร็จ (' + e.message + ') กำลังแสดงผลรอบก่อน จะลองใหม่อัตโนมัติ');
      else { note(''); $('updated').textContent = 'ยังไม่มีผลการคำนวณ (' + e.message + ') ระบบจะคำนวณในรอบอัปเดตถัดไป'; }
    } finally { loading = false; }
  }
  document.querySelectorAll('.rk-filter input').forEach((i) => i.onchange = () => { show[i.dataset.t] = i.checked; draw(); });
  $('refresh').onclick = load;
  setInterval(load, F.REFRESH_MS);
  load();
})();
