// ตรวจเว็บจริงหลัง deploy: เปิดทุกหน้าด้วย Chrome แล้วรายงาน error และสถานะที่แต่ละหน้าแสดง
import { chromium } from 'playwright-core';
const BASE = process.env.SITE || 'https://apichaetth.github.io/bkk-flood-map/';
const PAGES = [
  ['index.html', '#updated'], ['map.html', '#updated'], ['traffy.html', '#updated'],
  ['risk.html', '#updated'], ['log.html', '#updated'], ['about.html', 'h1'],
];
const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
let bad = 0;
for (const [w, h, n] of [[390, 844, 'mobile'], [1280, 900, 'desktop']]) {
  for (const [pg, sel] of PAGES) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
    p.on('requestfailed', (r) => { if (!/tile\.openstreetmap|google-analytics/.test(r.url())) errs.push('failed: ' + r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText); });
    const t0 = Date.now();
    try {
      await p.goto(BASE + pg + '?smoke=' + Date.now(), { waitUntil: 'load', timeout: 60000 });
      await p.waitForTimeout(pg === 'index.html' || pg === 'map.html' ? 25000 : 8000);
      const info = await p.evaluate((sel) => ({
        status: (document.querySelector(sel) || {}).textContent?.trim().slice(0, 160),
        warn: (document.getElementById('warn') || {}).hidden === false ? document.getElementById('warn').textContent.slice(0, 160) : '',
        rk: (document.getElementById('rkStatus') || {}).hidden === false ? document.getElementById('rkStatus').textContent : '',
        tabs: [...document.querySelectorAll('nav.pages a')].map((a) => a.textContent).join('|'),
        locate: document.querySelector('.leaflet-container') ? !!document.querySelector('[title*="ตำแหน่ง"]') : null,
        hscroll: document.documentElement.scrollWidth > innerWidth,
        extra: document.getElementById('olRain') ? document.getElementById('olRain').textContent.trim().slice(0, 80) : '',
      }), sel);
      const ms = Date.now() - t0;
      if (errs.length || info.hscroll || info.locate === false || info.tabs.split('|').length !== 6) bad++;
      console.log(`\n[${n}] ${pg} (${ms} ms)\n  ${JSON.stringify(info)}${errs.length ? '\n  ' + [...new Set(errs)].slice(0, 12).join('\n  ') : ''}`);
    } catch (e) { bad++; console.log(`\n[${n}] ${pg} FAILED ${e.message}`); }
    await p.close();
  }
}
await b.close();
console.log(`\nสรุป: ${bad ? bad + ' หน้ามีปัญหา' : 'ทุกหน้าผ่าน'}`);
