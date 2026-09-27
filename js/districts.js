/* หน้าเขต: ระบายสี 50 เขตตามคะแนนรวม (ความรุนแรง + จำนวนจุด) จากทุกแหล่ง */
(function () {
  'use strict';
  const F = Flood, A = FloodAgg;
  const { $, esc, fmtTime, ago } = F;
  // 5 ระดับ เหลือง → แดงเข้ม (มีข้อความกำกับเสมอ ไม่พึ่งสีอย่างเดียว)
  const STEPS = [
    { min: 12, color: '#a8151f', label: 'หนักมาก' },
    { min: 6, color: '#df5139', label: 'หนัก' },
    { min: 3, color: '#f59245', label: 'ปานกลาง' },
    { min: 1, color: '#fcc873', label: 'เล็กน้อย' },
    { min: 0.01, color: '#fef0c2', label: 'เฝ้าระวัง' },
  ];
  const stepOf = (score) => STEPS.find((s) => score >= s.min) || null;
  const scoreOf = (d) => 3 * d[3] + d[2] + 0.5 * d.news + 0.3 * d[1];
  const mapLink = (c) => `map.html?lat=${c.la.toFixed(5)}&lng=${c.lo.toFixed(5)}&z=16`;

  const map = L.map('dmap', { scrollWheelZoom: false, minZoom: 9, maxZoom: 16, zoomSnap: 0.25 }).setView([13.75, 100.6], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  F.addLocate(map);
  const layer = L.layerGroup().addTo(map);
  let geo = null, fitted = false, byName = new Map(), shapes = new Map();
  let trend = new Map(); // แนวโน้มน้ำรายเขต จาก data/trends.json

  $('dLegend').innerHTML = STEPS.slice().reverse().map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('') + '<span><i class="none"></i>ไม่มีรายงาน</span>';
  const trendBadge = (name) => { const c = trend.get(name); return c ? `<b>${F.TREND_Z[c.z][0]} ${F.TREND_Z[c.z][1]}</b>` : ''; };

  function popupOf(name) {
    const d = byName.get(name);
    const tc = trend.get(name), tl = tc ? `<div style="margin-top:4px">${trendBadge(name)} <span class="m">(${F.trendText(tc)} · เทียบ 30 นาทีก่อน)</span></div>` : '';
    if (!d) return `<div class="pp"><h3>เขต${esc(name)}</h3><div class="m">ยังไม่มีรายงานน้ำท่วมหรือพื้นที่เสี่ยง</div>${tl}</div>`;
    const st = stepOf(d.score);
    const list = d.clusters.filter((c) => c.tier >= 2).sort((a, b) => b.tier - a.tier || (b.cm || 0) - (a.cm || 0)).slice(0, 8);
    return `<div class="pp"><span class="badge" style="--c:${st.color}">${st.label}</span><h3>เขต${esc(name)}</h3>
      <div class="m">ยืนยัน ${d[3]} · มีรายงาน ${d[2]}${d.news ? ` · ข่าว ${d.news}` : ''} · เสี่ยง ${d[1]}</div>${tl}
      ${list.length ? `<ul class="plist">${list.map((c) => `<li><a href="${mapLink(c)}">${esc(c.name)}</a>${c.cm ? ` · ${Math.round(c.cm)} ซม.` : ''}${c.t ? ` <span class="m">${ago(c.t)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${d.clusters.length > list.length ? `<div class="m">และอื่น ๆ อีก ${d.clusters.length - list.length} จุด (รวมพื้นที่เสี่ยง)</div>` : ''}</div>`;
  }
  function draw(dists) {
    byName = new Map(dists.map((d) => { d.score = scoreOf(d); return [d.name, d]; }));
    layer.clearLayers(); shapes = new Map();
    if (!geo) return;
    L.geoJSON(geo, {
      style: (f) => {
        const d = byName.get(f.properties.name), st = d && stepOf(d.score);
        return { color: '#fff', weight: 1.2, fillColor: st ? st.color : '#9aa4b1', fillOpacity: st ? 0.82 : 0.12 };
      },
      onEachFeature: (f, l) => {
        shapes.set(f.properties.name, l);
        const d = byName.get(f.properties.name);
        l.bindTooltip(`<b>เขต${esc(f.properties.name)}</b>${d ? ` · ${stepOf(d.score).label}` : ''}`, { sticky: true });
        l.bindPopup(() => popupOf(f.properties.name), { maxWidth: 320 });
        l.on('mouseover', () => l.setStyle({ weight: 3, color: '#1d2330' }));
        l.on('mouseout', () => l.setStyle({ weight: 1.2, color: '#fff' }));
      },
    }).addTo(layer);
    // ลูกศรแนวโน้มกลางเขต: ⬆ น้ำกำลังเพิ่ม · ⏸ ใกล้จุดสูงสุด · ⬇ กำลังลด
    for (const [n, c] of trend) {
      const l = shapes.get(n); if (!l) continue;
      L.marker(l.getBounds().getCenter(), { icon: L.divIcon({ className: '', iconSize: [34, 24], iconAnchor: [17, 12],
        html: `<div class="trz neutral${F.TREND_Z[c.z][0].length > 1 ? ' two' : ''}">${F.TREND_Z[c.z][0]}</div>` }), zIndexOffset: c.z === 'fast' ? 400 : 0 })
        .bindTooltip(`เขต${esc(n)} · น้ำ${F.TREND_Z[c.z][1]}`).bindPopup(() => popupOf(n), { maxWidth: 320 }).addTo(layer);
    }
    $('dTrendLg').hidden = !trend.size;
    if (!fitted) { map.fitBounds(L.geoJSON(geo).getBounds(), { padding: [6, 6] }); fitted = true; }
    const ranked = [...byName.values()].sort((a, b) => b.score - a.score);
    const max = Math.max(1, ...ranked.map((d) => d.score));
    $('dCount').textContent = `${ranked.filter((d) => d[3] + d[2] + d.news).length} เขตมีรายงาน · ${ranked.length} เขตมีรายงานหรือเสี่ยง`;
    $('dRank').innerHTML = ranked.length ? ranked.map((d) => {
      const st = stepOf(d.score);
      return `<li><button type="button" data-n="${esc(d.name)}"><span class="dn">เขต${esc(d.name)}</span>
        <span class="dbar"><i style="width:${Math.max(4, (d.score / max) * 100)}%;background:${st.color}"></i></span>
        <span class="dv">${st.label}${trend.get(d.name) ? ' ' + F.TREND_Z[trend.get(d.name).z][0] : ''}<small>${[d[3] ? `ยืนยัน ${d[3]}` : '', d[2] ? `รายงาน ${d[2]}` : '', d.news ? `ข่าว ${d.news}` : '', d[1] ? `เสี่ยง ${d[1]}` : ''].filter(Boolean).join(' · ')}</small></span></button></li>`;
    }).join('') : '<li class="muted">ยังไม่มีเขตที่มีรายงานน้ำท่วมหรือพื้นที่เสี่ยง</li>';
    $('dRank').querySelectorAll('button').forEach((b) => b.onclick = () => {
      const l = shapes.get(b.dataset.n); if (!l) return;
      map.fitBounds(l.getBounds(), { maxZoom: 13 }); l.openPopup(l.getBounds().getCenter());
      $('dmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const FEEDS = [['sensor', 'fetchSensors'], ['event', 'fetchEvents'], ['traffy', 'fetchTraffy'], ['rain', 'fetchRain'], ['wl', 'fetchWl'], ['news', 'fetchNews'], ['web', 'fetchWebReports']];
  let gen = 0, last = 0;
  async function refresh() {
    const my = ++gen; last = Date.now();
    $('updated').textContent = 'กำลังโหลด…';
    geo = geo || await F.loadDistricts().catch(() => null);
    const td = await F.getJSON('data/trends.json', 20000, { cache: 'no-cache' }).catch(() => null);
    trend = td && Date.now() - new Date(td.updated) <= 90 * 6e4 ? F.trendByDistrict(td, geo) : new Map();
    const D = {}; let left = FEEDS.length, timer = null;
    const render = () => {
      if (my !== gen) return;
      const dists = A.byDistrict(A.cluster(A.signals(D), geo), D.news);
      draw(dists);
      $('updated').textContent = left ? `กำลังโหลดข้อมูล… (เหลือ ${left} แหล่ง)` : `อัปเดต ${fmtTime(new Date(last))} · รีเฟรชอัตโนมัติทุก 15 นาที`;
    };
    await Promise.all(FEEDS.map(([k, fn]) => F[fn]().then((r) => { D[k] = r.items; }).catch(() => { D[k] = null; })
      .finally(() => { left--; clearTimeout(timer); timer = setTimeout(render, 150); })));
    clearTimeout(timer); render();
  }
  $('refresh').onclick = refresh;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > F.REFRESH_MS) refresh(); });
  setInterval(refresh, F.REFRESH_MS);
  refresh();
})();
