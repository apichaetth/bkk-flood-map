// ทดสอบแบบผู้ใช้จริงบนเว็บจริง: เปิดหน้า กดปุ่ม ค้นหา ปักที่ หาเส้นทาง แล้วเก็บภาพหน้าจอ + เวลา + error
// ผลอยู่ใน ux-out/ (report.txt และภาพ .jpg) — workflow ux-test.yml ส่งขึ้น branch ux-report
// ไม่ส่งรายงานน้ำท่วมจริง (เปิดฟอร์มดูเท่านั้น)
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
const BASE = process.env.SITE || 'https://apichaetth.github.io/bkk-flood-map/';
const OUT = 'ux-out';
await mkdir(OUT, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const HOME = { latitude: 13.8163, longitude: 100.5605 }; // แถวลาดพร้าว
let shot = 0;

async function ctxFor(kind, dark) {
  const mobile = kind === 'm';
  return b.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 860 }, isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: 1, locale: 'th-TH', timezoneId: 'Asia/Bangkok', geolocation: HOME, permissions: ['geolocation'],
    colorScheme: dark ? 'dark' : 'light',
    userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' : undefined,
  });
}
function watch(p, tag) {
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
  p.on('response', (r) => { if (r.status() >= 400 && !/tile\.openstreetmap/.test(r.url())) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 110)}`); });
  p.on('requestfailed', (r) => { if (!/tile\.openstreetmap|google-analytics|youtube|facebook/.test(r.url())) errs.push('failed ' + r.url().slice(0, 110) + ' ' + ((r.failure() || {}).errorText || '')); });
  return () => { if (errs.length) say(`   ⚠ ${tag} errors (${errs.length}):\n     ` + [...new Set(errs)].slice(0, 8).join('\n     ')); };
}
async function snap(p, name, full = false) {
  const f = `${String(++shot).padStart(2, '0')}-${name}.jpg`;
  await p.screenshot({ path: `${OUT}/${f}`, type: 'jpeg', quality: 55, fullPage: full }).catch((e) => say('   shot failed', name, e.message));
  say('   📸', f);
}
const txt = (p, sel) => p.locator(sel).first().innerText({ timeout: 3000 }).then((s) => s.replace(/\s+/g, ' ').trim().slice(0, 220)).catch(() => '(ไม่พบ)');
async function until(p, fn, ms, arg) { const t0 = Date.now(); try { await p.waitForFunction(fn, arg, { timeout: ms }); return Date.now() - t0; } catch { return null; } }
const step = async (name, fn) => { say('\n## ' + name); try { await fn(); } catch (e) { say('   ✖ ล้มเหลว:', e.message.split('\n')[0].slice(0, 200)); } };

for (const kind of ['m', 'd']) {
  const K = kind === 'm' ? 'มือถือ' : 'คอม';
  const ctx = await ctxFor(kind);
  await ctx.route('**/version.txt*', (r) => r.fulfill({ body: 'x' })).catch(() => {});

  await step(`[${K}] หน้าแรก: เปิดแล้วรู้ไหมว่าตอนนี้น้ำท่วมตรงไหน`, async () => {
    const p = await ctx.newPage(); const done = watch(p, 'home');
    const t0 = Date.now();
    await p.goto(BASE + '?ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    say('   DOM พร้อม', Date.now() - t0, 'ms');
    const tHead = await until(p, () => { const h = document.getElementById('headline'); return h && h.textContent.trim() && !/กำลัง/.test(h.textContent); }, 45000);
    say('   หัวข้อคำตอบแสดงใน', tHead == null ? '> 45 วิ (ไม่ขึ้น)' : tHead + ' ms หลัง DOM');
    await snap(p, `${kind}-home-first`);
    say('   หัวข้อ:', await txt(p, '#headline')); say('   รอง:', await txt(p, '#subline'));
    say('   ตัวเลข: ยืนยัน', await txt(p, '#nConfirmed'), '· มีรายงาน', await txt(p, '#nReported'), '· เสี่ยง', await txt(p, '#nRisk'), '· เขต', await txt(p, '#nDistricts'));
    say('   อัปเดต:', await txt(p, '#updated'));
    await p.waitForTimeout(12000);
    say('   จำนวนจุดทั้งหมด:', await txt(p, '#allCount'), '· แนวโน้ม: เพิ่ม', await txt(p, '#trUpN'), 'ใกล้สูงสุด', await txt(p, '#trPeakN'), 'ลด', await txt(p, '#trDownN'));
    const warn = await p.locator('#warn').isVisible().catch(() => false);
    if (warn) say('   ⚠ แถบเตือนบนหน้า:', await txt(p, '#warn'));
    const tiny = await p.evaluate(() => [...document.querySelectorAll('a,button,input,select,summary,label')].filter((e) => { const r = e.getBoundingClientRect(); return e.offsetParent && r.width > 0 && r.height > 0 && (r.height < 30 || r.width < 30); }).map((e) => (e.innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 25)).slice(0, 12));
    say('   ปุ่ม/ลิงก์ที่เล็กกว่า 30px:', tiny.length ? tiny.join(' | ') : 'ไม่มี');
    await snap(p, `${kind}-home-full`, true);
    // ค้นหาถนน
    await p.fill('#heroQ', 'ลาดพร้าว'); await p.press('#heroQ', 'Enter'); await p.waitForTimeout(1500);
    say('   ค้นหา "ลาดพร้าว" → รายการ:', await p.locator('#spots > *').count(), 'รายการ ·', await txt(p, '#spots'));
    await snap(p, `${kind}-home-search`);
    // ใกล้ฉัน
    await p.fill('#heroQ', ''); await p.locator('#heroQ').dispatchEvent('input');
    await p.click('#heroNear'); await p.waitForTimeout(3000);
    say('   กด "ใกล้ฉัน" →', await txt(p, '#spots'));
    await snap(p, `${kind}-home-near`);
    done(); await p.close();
  });

  await step(`[${K}] แผนที่ละเอียด: โหลดเร็วไหม กดหมุดได้ไหม`, async () => {
    const p = await ctx.newPage(); const done = watch(p, 'map');
    const t0 = Date.now();
    await p.goto(BASE + 'map.html?ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const tS = await until(p, () => /\d/.test((document.getElementById('kSensor') || {}).textContent || ''), 60000);
    say('   ตัวเลขเซ็นเซอร์ขึ้นใน', tS == null ? '> 60 วิ' : (Date.now() - t0) + ' ms');
    const tT = await until(p, () => /\d/.test((document.getElementById('kTraffy') || {}).textContent || ''), 60000);
    say('   ตัวเลข Traffy ขึ้นใน', tT == null ? '> 60 วิ' : (Date.now() - t0) + ' ms');
    await p.waitForTimeout(4000);
    say('   KPI:', await txt(p, '.kpis'));
    say('   หมุดบนแผนที่ (HTML):', await p.locator('.leaflet-marker-icon').count());
    await snap(p, `${kind}-map`);
    // กดหมุดเซ็นเซอร์ตัวแรกที่มองเห็น
    const pin = p.locator('.mk.sensor').first();
    if (await pin.count()) {
      await pin.click({ force: true, timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(800);
      say('   กดหมุดเซ็นเซอร์ → ป๊อปอัป:', await txt(p, '.leaflet-popup-content'));
      await snap(p, `${kind}-map-popup`);
      await p.keyboard.press('Escape');
    }
    // แท็บที่ของฉัน: เพิ่มที่ด้วยการค้นหา
    await p.click('.tabs [data-tab="pl"]'); await p.waitForTimeout(500);
    await p.click('#plAdd'); await p.fill('#plQ', 'เซ็นทรัล ลาดพร้าว'); await p.waitForTimeout(3500);
    const sug = p.locator('#plSug button');
    say('   ค้นหาที่ "เซ็นทรัล ลาดพร้าว" → ผลลัพธ์', await sug.count(), 'รายการ');
    if (await sug.count()) { await sug.first().click(); await p.waitForTimeout(1500); }
    else { await p.click('#plHere'); await p.waitForTimeout(3000); }
    say('   ที่ของฉัน:', await txt(p, '#plList'));
    await snap(p, `${kind}-map-places`);
    // เปิดฟอร์มแจ้งน้ำท่วม (ไม่ส่ง)
    const rep = p.getByRole('button', { name: /แจ้งน้ำท่วม/ }).first();
    if (await rep.count()) { await rep.click().catch(() => {}); await p.waitForTimeout(1500); await snap(p, `${kind}-map-report-form`); say('   ฟอร์มแจ้ง:', await txt(p, '.rp-sheet, .report, dialog, [role=dialog]')); }
    done(); await p.close();
  });

  await step(`[${K}] เส้นทางเลี่ยงน้ำ: จากตำแหน่งฉันไปอนุสาวรีย์ชัยฯ`, async () => {
    const p = await ctx.newPage(); const done = watch(p, 'route');
    await p.goto(BASE + 'route.html?to=13.76488,100.53827&name=' + encodeURIComponent('อนุสาวรีย์ชัยสมรภูมิ') + '&ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(3000);
    await p.click('#meA'); await p.waitForTimeout(3000);
    say('   ปุ่มหาเส้นทางกดได้:', !(await p.locator('#go').isDisabled()));
    const t0 = Date.now();
    await p.click('#go', { timeout: 5000 });
    const tR = await until(p, () => { const s = (document.getElementById('rtStatus') || {}).textContent || ''; return !/กำลังหาเส้นทาง/.test(s) && (document.getElementById('result') || {}).textContent.trim(); }, 60000);
    say('   ได้เส้นทางใน', tR == null ? '> 60 วิ' : (Date.now() - t0) + ' ms', '· สถานะ:', await txt(p, '#rtStatus'));
    say('   ผล:', await txt(p, '#result'));
    await snap(p, `${kind}-route`, kind === 'm');
    done(); await p.close();
  });

  await step(`[${K}] เขต: เขตไหนหนัก กดดูได้ไหม`, async () => {
    const p = await ctx.newPage(); const done = watch(p, 'districts');
    await p.goto(BASE + 'districts.html?ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(15000);
    say('   สรุป:', await txt(p, '#dCount')); say('   อันดับแรก:', await txt(p, '#dRank li'));
    const bt = p.locator('#dRank button').first();
    if (await bt.count()) { await bt.click(); await p.waitForTimeout(1500); say('   ป๊อปอัปเขต:', await txt(p, '.leaflet-popup-content')); }
    await snap(p, `${kind}-districts`);
    done(); await p.close();
  });

  await step(`[${K}] ถนนเสี่ยง`, async () => {
    const p = await ctx.newPage(); const done = watch(p, 'risk');
    const t0 = Date.now();
    await p.goto(BASE + 'risk.html?ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(10000);
    say('   โหลด+รอ', Date.now() - t0, 'ms · สถานะ:', await txt(p, '#updated'));
    say('   รายการแรก:', await txt(p, '.rk-roads li, .rk-roads a'));
    await snap(p, `${kind}-risk`);
    done(); await p.close();
  });

  for (const pg of ['traffy.html', 'log.html', 'about.html']) {
    await step(`[${K}] ${pg}`, async () => {
      const p = await ctx.newPage(); const done = watch(p, pg);
      await p.goto(BASE + pg + '?ux=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(pg === 'traffy.html' ? 10000 : 4000);
      say('   สถานะ:', await txt(p, '#updated, h1'));
      await snap(p, `${kind}-${pg.replace('.html', '')}`);
      done(); await p.close();
    });
  }
  // เมนูบนมือถือ: แถบล่าง + แผ่น "อื่น ๆ"
  if (kind === 'm') await step('[มือถือ] เมนูแถบล่าง', async () => {
    const p = await ctx.newPage();
    await p.goto(BASE + '?ux=' + Date.now(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2000);
    say('   แถบล่าง:', await txt(p, '.tabbar'));
    const more = p.locator('.tabbar button, .tabbar a').last();
    await more.click().catch(() => {}); await p.waitForTimeout(800);
    say('   เมนูอื่น ๆ:', await txt(p, '.tsheet'));
    await snap(p, 'm-menu-more');
    await p.close();
  });
  await ctx.close();
}

await step('[มือถือ โหมดมืด] หน้าแรก + แผนที่', async () => {
  const ctx = await ctxFor('m', true);
  for (const pg of ['', 'map.html']) {
    const p = await ctx.newPage();
    await p.goto(BASE + pg + '?ux=' + Date.now(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(10000);
    await snap(p, 'm-dark-' + (pg ? 'map' : 'home'));
    await p.close();
  }
  await ctx.close();
});
await b.close();
await writeFile(`${OUT}/report.txt`, log.join('\n') + '\n');
