/* หน้าสถานการณ์รายเขต: สี = สถานการณ์ใน 3 ชม. ล่าสุด · ป้ายกลางเขต = แนวโน้ม (แย่ลง/ทรงตัว/ดีขึ้น)
 * ใช้ data/home.json ที่ระบบสรุปไว้ทุก 15 นาที (ส่วน z = สรุปรายเขต, c = จุดน้ำท่วม) */
(function () {
  'use strict';
  const F = Flood;
  const { $, esc, fmtTime, fmtDT, ago } = F;
  // ระดับสีของเขต (4 ระดับ + มีแต่รายงานเก่า)
  const LV = {
    3: { label: 'ท่วมหนัก', color: '#c62828' },
    2: { label: 'ท่วมหลายจุด', color: '#ef8a2c' },
    1: { label: 'มีรายงานบ้าง', color: '#f2cf45' },
    '-1': { label: 'มีแต่รายงานเก่า', color: '#c9ced6' },
    0: { label: 'ไม่มีรายงาน', color: '#eef0f3' },
  };
  const TR = { 1: ['▲ แย่ลง', 'worse'], 0: ['● ทรงตัว', 'steady'], '-1': ['▼ ดีขึ้น', 'better'] };

  const map = L.map('dmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 16, zoomSnap: 0.25 }).setView([13.75, 100.6], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  F.addLocate(map);
  const layer = L.layerGroup().addTo(map), labels = L.layerGroup().addTo(map);
  let geo = null, fitted = false, Z = new Map(), H = null, shapes = new Map(), gj = null;

  $('dLegend').innerHTML = [3, 2, 1, -1, 0].map((k) => `<span><i style="background:${LV[k].color}${k === -1 ? ';background-image:repeating-linear-gradient(45deg,transparent 0 3px,rgba(255,255,255,.8) 3px 5px)' : ''}"></i>${LV[k].label}</span>`).join('')
    + '<span class="dtr worse">▲ แย่ลง</span><span class="dtr steady">● ทรงตัว</span><span class="dtr better">▼ ดีขึ้น</span>';

  const spotsIn = (name) => (H ? H.c.filter((c) => c[4] === name && c[2] >= 2 && c[6] && Date.now() - c[6] <= 3 * 36e5)
    .sort((a, b) => b[2] - a[2] || b[5] - a[5] || b[6] - a[6]) : []);
  function popupOf(name) {
    const z = Z.get(name);
    if (!z || !z.lv) return `<div class="pp"><h3>เขต${esc(name)}</h3><div class="m">ไม่มีรายงานน้ำท่วมใน 24 ชม.</div></div>`;
    const lv = LV[z.lv], tr = z.trend != null ? TR[z.trend] : null;
    const list = spotsIn(name).slice(0, 6);
    return `<div class="pp"><span class="badge" style="--c:${lv.color}${z.lv === 1 || z.lv < 0 ? ';color:#1d2330' : ''}">${lv.label}</span>${tr ? ` <span class="dtr ${tr[1]}">${tr[0]}</span>` : ''}<h3>เขต${esc(name)}</h3>
      <div class="m">รายงานใน 3 ชม.: ${z.fresh} เรื่อง${z.conf ? ` · ยืนยันแล้ว ${z.conf} จุด` : ''}${z.max ? ` · ลึกสุด ${z.max} ซม.` : ''}${z.old ? ` · รายงานเก่า 3–24 ชม. ${z.old} เรื่อง` : ''}</div>
      ${z.why.length ? `<div class="m" style="margin-top:4px">แนวโน้ม: ${z.why.map(esc).join(' · ')}</div>` : ''}
      ${list.length ? `<ul class="plist">${list.map((c) => `<li><a href="map.html?lat=${c[0]}&lng=${c[1]}&z=16">${esc(c[3])}</a>${c[5] ? ` · ${c[5]} ซม.` : ''} <span class="m">${ago(new Date(c[6]))}</span></li>`).join('')}</ul>` : ''}</div>`;
  }
  const styleOf = (f) => {
    const z = Z.get(f.properties.name), k = z ? z.lv : 0;
    return { color: k === -1 ? '#8a93a0' : '#fff', weight: k === -1 ? 1 : 1.2, dashArray: k === -1 ? '4 3' : null, fillColor: LV[k].color, fillOpacity: k > 0 ? 0.78 : k === -1 ? 0.55 : 0.35 };
  };
  function draw() {
    layer.clearLayers(); labels.clearLayers(); shapes = new Map();
    if (!geo) return;
    gj = L.geoJSON(geo, {
      style: styleOf,
      onEachFeature: (f, l) => {
        shapes.set(f.properties.name, l);
        const z = Z.get(f.properties.name);
        l.bindTooltip(`<b>เขต${esc(f.properties.name)}</b>${z && z.lv ? ` · ${LV[z.lv].label}${z.trend != null ? ' · ' + TR[z.trend][0] : ''}` : ''}`, { sticky: true });
        l.bindPopup(() => popupOf(f.properties.name), { maxWidth: 320 });
        l.on('mouseover', () => l.setStyle({ weight: 3, color: '#1d2330' }));
        l.on('mouseout', () => gj.resetStyle(l));
      },
    }).addTo(layer);
    drawLabels();
    if (!fitted) { map.fitBounds(L.geoJSON(geo).getBounds(), { padding: [6, 6] }); fitted = true; }
    // อันดับ: หนักสุดก่อน แล้วตามจำนวนรายงานใหม่ (เขตที่มีแต่รายงานเก่าอยู่ท้าย)
    const rank = (z) => (z.lv === -1 ? 0.5 : z.lv);
    const ranked = [...Z.values()].filter((z) => z.lv !== 0).sort((a, b) => rank(b) - rank(a) || b.fresh - a.fresh || b.old - a.old);
    const nNow = ranked.filter((z) => z.lv > 0).length;
    const nW = ranked.filter((z) => z.trend === 1).length, nB = ranked.filter((z) => z.trend === -1).length;
    $('dCount').textContent = `${nNow} เขตมีน้ำท่วมใน 3 ชม. · แย่ลง ${nW} · ดีขึ้น ${nB}`;
    $('dRank').innerHTML = ranked.length ? ranked.map((z) => {
      const lv = LV[z.lv], tr = z.trend != null ? TR[z.trend] : null;
      return `<li><button type="button" data-n="${esc(z.name)}"><span class="dn">เขต${esc(z.name)}</span>
        <span class="dbar"><i style="width:${Math.max(4, Math.min(100, z.fresh * 5))}%;background:${lv.color}"></i></span>
        <span class="dv">${lv.label}${tr ? ` <span class="dtr ${tr[1]}">${tr[0]}</span>` : ''}<small>${[z.fresh ? `3 ชม.: ${z.fresh} เรื่อง` : '', z.conf ? `ยืนยัน ${z.conf}` : '', z.max ? `ลึกสุด ${z.max} ซม.` : '', z.old ? `เก่า ${z.old}` : ''].filter(Boolean).join(' · ')}</small></span></button></li>`;
    }).join('') : '<li class="muted">ขณะนี้ไม่มีเขตที่มีรายงานน้ำท่วม</li>';
    $('dRank').querySelectorAll('button').forEach((b) => b.onclick = () => {
      const l = shapes.get(b.dataset.n); if (!l) return;
      map.fitBounds(l.getBounds(), { maxZoom: 13 }); l.openPopup(l.getBounds().getCenter());
      $('dmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ป้ายแนวโน้มกลางเขต: เฉพาะแย่ลง/ดีขึ้น (ทรงตัวดูในป๊อปอัปและอันดับ) · เขตที่เล็กบนจอแสดงแค่ ▲/▼ ไม่ให้ป้ายทับกัน
  function drawLabels() {
    labels.clearLayers();
    for (const [n, z] of Z) {
      const l = shapes.get(n);
      if (!l || z.trend == null || z.trend === 0) continue;
      const b = l.getBounds(), w = map.latLngToContainerPoint(b.getNorthEast()).x - map.latLngToContainerPoint(b.getSouthWest()).x;
      const [t, cls] = TR[z.trend], short = w < 90;
      L.marker(b.getCenter(), { icon: L.divIcon({ className: '', iconSize: short ? [24, 22] : [64, 22], iconAnchor: short ? [12, 11] : [32, 11], html: `<span class="dtr ${cls}${short ? ' sm' : ''}">${short ? t[0] : t}</span>` }), keyboard: false })
        .bindTooltip(`เขต${esc(n)} · ${t}`).bindPopup(() => popupOf(n), { maxWidth: 320 }).addTo(labels);
    }
  }
  map.on('zoomend', () => { if (Z.size) drawLabels(); });

  let last = 0;
  async function refresh() {
    last = Date.now();
    $('updated').textContent = 'กำลังโหลด…';
    geo = geo || await F.loadDistricts().catch(() => null);
    try {
      H = await F.getJSON('data/home.json', 20000, { cache: 'no-cache' });
      Z = new Map((H.z || []).map(([name, lv, fresh, conf, max, old, trend, why]) => [name, { name, lv, fresh, conf, max, old, trend, why: why || [] }]));
      $('updated').textContent = `อัปเดต ${fmtTime(new Date(H.updated))} · รีเฟรชอัตโนมัติทุก 15 นาที`;
      $('dNote').textContent = `ข้อมูล ณ ${fmtDT(new Date(H.updated))}`;
    } catch (e) {
      $('updated').textContent = 'โหลดข้อมูลไม่สำเร็จ: ' + e.message;
    }
    draw();
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > F.REFRESH_MS) refresh(); });
  setInterval(refresh, F.REFRESH_MS);
  refresh();
})();
