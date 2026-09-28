/* หน้าประมาณการถนนเสี่ยงน้ำท่วม (ทดลอง): อ่าน data/risk-roads.json ที่ GitHub Actions คำนวณทุก 15 นาที */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtDT, cssVar } = F;
  const NAME = { 3: 'ควรระวังมาก', 2: 'ควรระวัง', 1: 'เฝ้าระวัง' };
  const COLOR = () => ({ 3: cssVar('--rk3'), 2: cssVar('--rk2'), 1: cssVar('--rk1') });
  // ระดับ 1 (เฝ้าระวัง) เลิกใช้แล้ว ซ่อนไว้เผื่อข้อมูลรอบเก่าที่ค้างในเครื่อง
  const show = { 1: false, 2: true, 3: true };
  const SRC = ['หน่วยงาน/iTIC', 'Traffy', 'ประชาชนปักหมุด', 'ข่าว', 'เซ็นเซอร์ถนน กทม.'];
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
    const [src, dist, age, mm1, mm24, hc, pct, st, fc, mc] = s.x, w = [];
    if (src >= 0) w.push(`มีรายงานน้ำท่วม (${SRC[src]}) ห่าง ${dist} ม. เมื่อ ${age} นาทีที่แล้ว`);
    if (mm1 >= 0) w.push(`ฝนแถวนี้ประมาณ ${mm1} มม./ชม. · ${mm24} มม./24 ชม.`);
    if (fc >= 0) w.push(`กรมอุตุฯ คาดฝนอีกราว ${fc} มม. ใน 3 ชม. ข้างหน้า`);
    if (hc) w.push(`เคยมีคนแจ้งน้ำท่วมแถวนี้ ${hc} ครั้งในช่วงที่ผ่านมา`);
    if (mc > 0) w.push(`ระบบเรียนรู้: แถวนี้ท่วมจริงแต่เตือนไม่ทัน ${mc} ครั้งใน 7 วัน จึงให้ไวต่อฝนขึ้น`);
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
    // วาดขอบขาวของทุกช่วงก่อน แล้วค่อยวาดเส้นสีทับทั้งหมด ช่วงที่ต่อกันจะเป็นเส้นเดียวไม่มีรอยขาวคั่น
    for (const s of segs) if (s.tier > 1) L.polyline(s.c, { color: '#fff', weight: s.tier === 3 ? 11 : 9, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
    for (const s of segs) {
      L.polyline(s.c, { color: col[s.tier], weight: s.tier === 3 ? 7 : s.tier === 2 ? 6 : 4, opacity: 1, dashArray: s.tier === 1 ? '8 6' : null, lineCap: 'round', lineJoin: 'round' })
        .bindPopup(() => pop(s), { maxWidth: 320 }).addTo(layer);
    }
    if (!fitted && segs.length) { map.fitBounds(L.latLngBounds(segs.flatMap((s) => s.c)).pad(0.1), { maxZoom: 14 }); fitted = true; }
  }
  function renderSide() {
    const c = data.counts || {};
    $('n3').textContent = (c[3] || 0).toLocaleString(); $('n2').textContent = (c[2] || 0).toLocaleString();
    // รวมตามชื่อถนน + เขต
    const byRoad = new Map();
    for (const s of data.segments.filter((x) => show[x.tier])) {
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
    renderEval(data.accuracy);
  }
  // ---------- วัดผล ----------
  const pc = (h, n) => (n ? Math.round((1000 * h) / n) / 10 : null);
  const pcs = (h, n) => (n ? pc(h, n) + '%' : '–');
  const n0 = (v) => (v || 0).toLocaleString();
  const fmtDay = (k) => new Date(k + 'T12:00:00+07:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  function renderEval(a) {
    const box = $('evalBox');
    // ไฟล์รูปแบบเดิม (ก่อน v3): ยังไม่มีสถิติแบบใหม่
    if (!a || a.v !== 3 || !a.total.runs) {
      $('acc').textContent = '–'; $('accSub').textContent = '(รอข้อมูล)'; $('rec').textContent = '–';
      box.innerHTML = '<p class="muted">เริ่มเก็บสถิติชุดใหม่แล้ว ต้องรอผลการทายอย่างน้อย 3 ชม. แรกก่อน จึงจะเริ่มวัดความแม่นได้ ยิ่งผ่านวันที่ฝนตกหนักหลายวัน ตัวเลขยิ่งเชื่อถือได้</p>';
      return;
    }
    const T = a.total, t3 = T.t[3], t2 = T.t[2], rec = T.rec;
    const recAll = ['main', 'soi'].reduce((x, k) => [x[0] + rec[k][0], x[1] + rec[k][1]], [0, 0]);
    const nDays = a.days.length;
    $('acc').textContent = pcs(t3[1], t3[0]);
    $('accSub').textContent = `(${nDays} วัน · ${n0(T.runs)} รอบ)`;
    $('rec').textContent = pcs(recAll[1], recAll[0]);
    $('recSub').textContent = recAll[0] ? `(พลาด ${n0(recAll[0] - recAll[1])} จาก ${n0(recAll[0])} เรื่อง)` : '';
    const p3 = pc(t3[1], t3[0]), pb = pc(T.base[1], T.base[0]);
    let verdict = '';
    if (p3 != null && pb != null && t3[0] >= 200) {
      verdict = p3 > pb * 1.2 ? `<p class="rk-verdict ok">ระดับควรระวังมากทายถูกมากกว่าวิธีง่าย ๆ (ทายแค่จุดที่ท่วมบ่อย) — ${p3}% เทียบกับ ${pb}%</p>`
        : `<p class="rk-verdict warn">ยังไม่ดีกว่าวิธีง่าย ๆ (ทายแค่จุดที่ท่วมบ่อย) ชัดเจน — ${p3}% เทียบกับ ${pb}% ต้องเก็บข้อมูลเพิ่มและปรับค่าน้ำหนัก</p>`;
    }
    if (nDays < 7) verdict += `<p class="muted small">เก็บข้อมูลมาแล้ว ${nDays} วัน ตัวเลขยังแกว่งได้มาก ควรดูอีกครั้งเมื่อผ่านวันที่ฝนตกหนักหลายวัน</p>`;
    const DRV = ['มีรายงาน/เซ็นเซอร์ใกล้ ๆ', 'ฝน (+จุดท่วมบ่อย)', 'น้ำในคลองใกล้ล้น'];
    const row = (label, c, note) => `<tr><td>${label}${note ? `<br><span class="muted small">${note}</span>` : ''}</td><td class="n">${n0(c[0])}</td><td class="n">${n0(c[1])}</td><td class="n"><b>${pcs(c[1], c[0])}</b></td></tr>`;
    const recRow = (label, c) => `<tr><td>${label}</td><td class="n">${n0(c[0])}</td><td class="n">${n0(c[1])}</td><td class="n"><b>${pcs(c[1], c[0])}</b></td></tr>`;
    box.innerHTML = `<div class="rk-eval">
      <p class="muted small">ทุกรอบที่ครบ ${a.horizonH} ชม. นับว่า "ถูก" เมื่อมีรายงานน้ำท่วมใหม่ (Traffy, iTIC, หมุดประชาชน, เซ็นเซอร์ กทม.) ในรัศมี ${a.hitM} ม. ภายใน ${a.horizonH} ชม. หลังทาย</p>
      ${verdict}
      <h3>ทายถูกกี่ %</h3>
      <table><thead><tr><th>ที่ทาย</th><th class="n">ช่วงถนน×รอบ</th><th class="n">มีรายงานจริง</th><th class="n">ถูก</th></tr></thead><tbody>
      ${row(NAME[3], t3)}
      ${row('&nbsp;└ ทายล่วงหน้า', [t3[2], t3[3]], `ตอนทายยังไม่มีใครแจ้งแถวนั้นใน ${a.aheadH} ชม. ก่อนหน้า`)}
      ${row(NAME[2], t2)}
      ${row('&nbsp;└ ทายล่วงหน้า', [t2[2], t2[3]])}
      ${row('ตัวเทียบ: จุดที่ท่วมบ่อย', T.base, 'ทายแค่ช่วงถนนที่มีคนแจ้งบ่อยที่สุด จำนวนเท่ากับระดับควรระวังมาก')}
      </tbody></table>
      <h3>ระดับควรระวังมาก แยกตามเหตุผลหลัก</h3>
      <table><tbody>${T.drv.map((c, i) => row(DRV[i], c)).join('')}</tbody></table>
      <h3>น้ำท่วมจริง ทายไว้ล่วงหน้าได้กี่ %</h3>
      <table><thead><tr><th>รายงานน้ำท่วมใหม่ (นับเรื่องละครั้ง)</th><th class="n">เรื่อง</th><th class="n">ทายไว้ก่อน</th><th class="n">%</th></tr></thead><tbody>
      ${recRow('บนถนนสายหลัก/รอง', rec.main)}${recRow('ในซอย', rec.soi)}${recRow('<b>รวม (ถนน/ซอยที่มีชื่อ)</b>', recAll)}
      ${recRow('<span class="muted">ไม่อยู่ใกล้ถนนที่มีชื่อ (ระบบไม่ได้ทาย ไม่นับรวม)</span>', rec.off)}
      </tbody></table>
      ${(a.missTop || []).length ? `<h3>พลาดบ่อยที่สุด (7 วัน)</h3>
      <p class="muted small">น้ำท่วมจริงแต่ไม่ได้ทายไว้ล่วงหน้า รวม ${n0(a.miss7)} เรื่อง · ใช้ดูว่าต้องปรับตรงไหน</p>
      <table><thead><tr><th>ถนน/บริเวณ</th><th class="n">พลาด</th><th>อยู่บน</th></tr></thead><tbody>
      ${a.missTop.map((m) => `<tr><td>${esc(m.name)}<br><span class="muted small">เขต${esc(m.district || '–')}</span></td><td class="n"><b>${n0(m.n)}</b></td><td class="small">${Object.entries(m.kinds).map(([k, v]) => `${{ main: 'ถนนหลัก', soi: 'ซอย', off: 'นอกถนนที่ระบบดู' }[k]} ${v}`).join(' · ')}</td></tr>`).join('')}
      </tbody></table>` : ''}
      <h3>รายวัน</h3>
      <table><thead><tr><th>วัน</th><th class="n">ฝนสูงสุด<br>มม./ชม.</th><th class="n">ควรระวังมาก<br>ถูก</th><th class="n">ตัวเทียบ<br>ถูก</th><th class="n">ทายไว้ก่อน</th></tr></thead><tbody>
      ${a.days.slice(0, 14).map((d) => {
        const r = ['main', 'soi'].reduce((x, k) => [x[0] + d.rec[k][0], x[1] + d.rec[k][1]], [0, 0]);
        return `<tr><td>${fmtDay(d.d)}</td><td class="n">${d.rain}</td><td class="n">${pcs(d.t[3][1], d.t[3][0])}</td><td class="n">${pcs(d.base[1], d.base[0])}</td><td class="n">${pcs(r[1], r[0])} <span class="muted small">(${r[0]})</span></td></tr>`;
      }).join('')}
      </tbody></table></div>`;
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
