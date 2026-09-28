// ภาพโฆษณา Facebook: ถ่ายหน้าจอมือถือจากเว็บจริง แล้วเรนเดอร์ promo/infographic.html เป็น PNG ทุกขนาด
// ผลลัพธ์: promo-out/*.png (square, portrait, story, carousel-1..5) + shots/
import { chromium } from 'playwright-core';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.SITE || 'https://apichaetth.github.io/bkk-flood-map/';
const LINK = 'https://apichaetth.github.io/bkk-flood-map/';
const SHOTS = path.join(ROOT, 'promo', 'shots'), OUT = path.join(ROOT, 'promo-out');
const SKIP_SHOTS = process.env.SKIP_SHOTS === '1';
await mkdir(SHOTS, { recursive: true }); await mkdir(OUT, { recursive: true });
const log = (...a) => console.log('[promo]', ...a);

const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });

// ตำแหน่ง "ฉัน" = ใกล้จุดน้ำท่วมล่าสุด (ให้หน้าแรกแสดงผลที่มีเนื้อหา) ถ้าไม่มีใช้อนุสาวรีย์ชัยฯ
async function pickSpot() {
  try {
    const r = await fetch(BASE + 'data/home.json?t=' + Date.now());
    const h = await r.json();
    const now = Date.now();
    const c = (h.c || []).filter((x) => x[2] >= 2 && x[6] && now - x[6] < 3 * 36e5).sort((a, b) => b[2] - a[2] || b[8] - a[8])[0];
    if (c) return { latitude: c[0] + 0.004, longitude: c[1] + 0.003 };
  } catch (e) { log('home.json', e.message); }
  return { latitude: 13.7649, longitude: 100.5383 };
}

if (!SKIP_SHOTS) {
  const geo = await pickSpot();
  log('me at', geo);
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'th-TH',
    geolocation: geo, permissions: ['geolocation'], timezoneId: 'Asia/Bangkok' });
  const shot = async (name, url, prep, wait = 8000) => {
    const p = await ctx.newPage();
    try {
      await p.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(wait);
      if (prep) await prep(p);
      await p.screenshot({ path: path.join(SHOTS, name + '.png') });
      log('shot', name);
    } catch (e) { log('shot failed', name, e.message); }
    await p.close();
  };
  await shot('home', '', async (p) => { await p.click('#meNear').catch(() => {}); await p.waitForTimeout(4000); });
  await shot('map', `map.html?lat=${geo.latitude.toFixed(4)}&lng=${geo.longitude.toFixed(4)}&z=13`, null, 12000);
  await shot('risk', 'risk.html', null, 12000);
  await shot('route', 'route.html?to=13.76488,100.53827&name=' + encodeURIComponent('อนุสาวรีย์ชัยสมรภูมิ'), async (p) => {
    await p.click('#meA').catch(() => {}); await p.waitForTimeout(2500);
    await p.click('#go', { timeout: 5000 }).catch(() => {});
    await p.waitForFunction(() => { const s = (document.getElementById('rtStatus') || {}).textContent || ''; return !/กำลังหาเส้นทาง/.test(s) && ((document.getElementById('result') || {}).textContent || '').trim(); }, null, { timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(1500);
  }, 4000);
  await shot('districts', 'districts.html', null, 15000);
  await ctx.close();
}

await QRCode.toFile(path.join(SHOTS, 'qr.png'), LINK, { margin: 1, width: 600, color: { dark: '#082f5cff', light: '#ffffffff' } });

const FORMATS = [['square', 1080, 1080], ['portrait', 1080, 1350], ['story', 1080, 1920], ['c1', 1080, 1080], ['c2', 1080, 1080], ['c3', 1080, 1080], ['c4', 1080, 1080], ['c5', 1080, 1080]];
const NAME = { square: 'fb-square-1080x1080', portrait: 'fb-portrait-1080x1350', story: 'fb-story-1080x1920', c1: 'carousel-1', c2: 'carousel-2', c3: 'carousel-3', c4: 'carousel-4', c5: 'carousel-5' };
const page = await b.newPage();
for (const [f, w, h] of FORMATS) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto('file://' + path.join(ROOT, 'promo', 'infographic.html') + '?f=' + f);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))); });
  await page.waitForTimeout(500);
  await page.locator('#cv').screenshot({ path: path.join(OUT, NAME[f] + '.png') });
  log('rendered', NAME[f]);
}
await b.close();
await mkdir(path.join(OUT, 'shots'), { recursive: true });
for (const f of await readdir(SHOTS)) await copyFile(path.join(SHOTS, f), path.join(OUT, 'shots', f));
