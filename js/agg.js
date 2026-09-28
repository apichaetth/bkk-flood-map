/* รวมข้อมูลทุกแหล่งเป็น "จุดน้ำท่วม" และสรุปรายเขต — ใช้ร่วมกันระหว่างหน้าภาพรวมและหน้าเขต */
window.FloodAgg = (function () {
  'use strict';
  const F = Flood;
  const { distKm, th } = F;
  const CLUSTER_KM = 0.5;

  // ระดับของจุด: 3 = ยืนยันแล้ว, 2 = มีรายงาน, 1 = เสี่ยง
  const TIER = {
    3: { label: 'ยืนยันแล้ว', long: 'น้ำท่วม (ยืนยันแล้ว)' },
    2: { label: 'มีรายงาน', long: 'มีรายงานน้ำท่วม' },
    1: { label: 'เสี่ยง', long: 'เสี่ยงน้ำท่วม' },
  };
  const SRC = {
    sensor: 'เซ็นเซอร์ กทม.', itic: 'หน่วยงาน/iTIC', web: 'ประชาชนปักหมุด', traffy: 'ประชาชนแจ้ง (Traffy)',
    news: 'ข่าว', youtube: 'คลิป YouTube', rain: 'ฝนหนัก', wl: 'ระดับน้ำสูง',
  };

  // ---------- 1) แปลงข้อมูลทุกแหล่งเป็น "สัญญาณ" ----------
  function signals(D) {
    const out = [];
    for (const x of D.sensor || []) if (x.lv > 0) {
      out.push({ la: x.la, lo: x.lo, src: 'sensor', tier: 3, name: x.s.name || x.s.road, detail: `วัดได้ ${Math.round(x.cm)} ซม.`, cm: x.cm, t: x.t, district: x.s.district });
    }
    for (const x of D.event || []) {
      out.push({ la: x.la, lo: x.lo, src: 'itic', tier: 3, name: String(x.e.title || '').replace(/^น้ำท่วม\s*/, ''), detail: x.why, cm: x.cm || 0, t: x.start });
    }
    for (const x of D.traffy || []) {
      out.push({ la: x.la, lo: x.lo, src: 'traffy', tier: 2, name: String(x.r.address || 'จุดที่ประชาชนแจ้ง').split(/\s+(?:แขวง|เขต)/)[0], detail: x.why, cm: x.cm || 0, t: x.t,
        link: `https://share.traffy.in.th/teamchadchart/${encodeURIComponent(x.r.ticket_id)}` });
    }
    for (const x of D.web || []) {
      out.push({ la: x.la, lo: x.lo, src: 'web', tier: 2, name: x.r.place || 'จุดที่ประชาชนปักหมุด', detail: `น้ำระดับ${x.r.level}${x.r.message ? ' · ' + x.r.message : ''}`, cm: 0, t: x.t,
        link: 'log.html?report=' + encodeURIComponent(x.r.id) });
    }
    for (const n of D.news || []) {
      if ((F.SEV_LV[n.severity] || 2) < 2) continue; // ข่าวเตือนภัย/น้ำลดแล้ว ไม่นับเป็นจุดน้ำท่วม
      if (n.type === 'อื่น ๆ') continue; // ข่าวเศรษฐกิจ/ความเห็น
      for (const p of n.pins || []) if (p.precision === 'place') {
        out.push({ la: p.lat, lo: p.lng, src: n.kind === 'youtube' ? 'youtube' : 'news', tier: 2, name: p.label, detail: `${n.source}: ${n.title}`, cm: 0, t: new Date(n.published), link: n.link, district: p.district });
      }
    }
    for (const s of D.rain || []) if (s.mm > F.RAIN_HEAVY_MM) {
      out.push({ la: s.la, lo: s.lo, src: 'rain', tier: 1, name: 'สถานีฝน ' + th(s.x.station.tele_station_name), detail: `ฝน ${s.mm} มม. ใน 24 ชม.`, cm: 0, t: s.t, radius: 350, mm: s.mm, district: th(s.x.geocode && s.x.geocode.amphoe_name) });
    }
    for (const s of D.wl || []) if (!s.stale && s.pct != null && s.pct >= 90) {
      out.push({ la: s.la, lo: s.lo, src: 'wl', tier: 1, name: th(s.x.station.tele_station_name), detail: `ระดับน้ำ ${s.pct.toFixed(0)}% ของตลิ่ง`, cm: 0, t: s.t, radius: 250, pct: s.pct });
    }
    return out;
  }

  // ---------- 2) รวมสัญญาณที่อยู่ใกล้กันเป็นจุดเดียว ----------
  const NAME_RANK = { sensor: 0, itic: 1, news: 2, youtube: 3, web: 4, traffy: 5, wl: 6, rain: 7 };
  function cluster(sig, geo) {
    const sorted = [...sig].sort((a, b) => b.tier - a.tier || (b.t || 0) - (a.t || 0));
    const cl = [];
    for (const s of sorted) {
      const hit = cl.find((c) => distKm(c.la, c.lo, s.la, s.lo) <= CLUSTER_KM);
      if (hit) hit.members.push(s);
      else cl.push({ la: s.la, lo: s.lo, members: [s] });
    }
    for (const c of cl) {
      const reports = c.members.filter((m) => m.tier >= 2);
      c.sources = [...new Set(reports.map((m) => m.src))];
      const maxTier = Math.max(...c.members.map((m) => m.tier));
      // รายงานจาก 2 แหล่งขึ้นไป (เช่น Traffy + ข่าว) ถือว่ายืนยันแล้ว
      c.tier = maxTier >= 2 && c.sources.length >= 2 ? 3 : maxTier;
      const best = [...c.members].sort((a, b) => NAME_RANK[a.src] - NAME_RANK[b.src])[0];
      c.name = best.name || 'ไม่ระบุชื่อ';
      c.cm = Math.max(0, ...c.members.map((m) => m.cm || 0));
      c.t = c.members.reduce((t, m) => (m.t && (!t || m.t > t) ? m.t : t), null);
      c.district = (geo && F.districtAt(geo, c.la, c.lo)) || c.members.map((m) => m.district).find(Boolean) || '';
      c.score = c.tier * 1000 + c.sources.length * 100 + c.cm;
    }
    return cl.sort((a, b) => b.score - a.score || (b.t || 0) - (a.t || 0));
  }

  // ---------- 3) สรุปรายเขต ----------
  function byDistrict(clusters, news) {
    const m = new Map();
    const get = (name) => { if (!m.has(name)) m.set(name, { name, 3: 0, 2: 0, 1: 0, news: 0, clusters: [] }); return m.get(name); };
    for (const c of clusters) if (c.district) { const d = get(c.district); d[c.tier]++; d.clusters.push(c); }
    // ข่าวที่ระบุได้แค่ระดับเขต นับเป็น "มีรายงาน" ของเขตนั้น
    for (const n of news || []) if ((F.SEV_LV[n.severity] || 2) >= 2) {
      for (const p of n.pins || []) if (p.precision === 'district' && p.district) get(p.district).news++;
    }
    for (const d of m.values()) {
      d.level = d[3] ? 3 : d[2] || d.news ? 2 : d[1] ? 1 : 0;
      d.score = d[3] * 100 + d[2] * 10 + d.news * 5 + d[1];
    }
    return [...m.values()].filter((d) => d.level).sort((a, b) => b.level - a.level || b.score - a.score);
  }

  return { TIER, SRC, signals, cluster, byDistrict, CLUSTER_KM };
})();
