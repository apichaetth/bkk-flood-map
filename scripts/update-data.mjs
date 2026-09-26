// ดึงข่าวน้ำท่วม กทม. + ประกาศเตือนภัยกรมอุตุฯ แล้วเขียนไฟล์ JSON ลง data/
// รันโดย GitHub Actions ทุก 15 นาที (ดู .github/workflows/update-data.yml)
// ใช้ Node 22+ ไม่มี dependency ภายนอก
//
// env ที่ใช้ได้ (ตั้งเป็น GitHub Secrets):
//   GEMINI_API_KEY  – key ฟรีจาก https://aistudio.google.com/apikey (ไม่มีก็ทำงานได้ แต่ไม่มีสรุปด้วย AI)
//   GEMINI_MODEL    – ค่าเริ่มต้น gemini-flash-latest
//   TMD_UID, TMD_UKEY – key กรมอุตุฯ จาก https://data.tmd.go.th/api/index1.php (ไม่มีจะใช้ demo)
//   YOUTUBE_API_KEY – key ฟรีจาก Google Cloud (YouTube Data API v3) ไม่มีก็ข้ามส่วนคลิป

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UA = 'bkk-flood-map/1.0 (+https://github.com/apichaetth/bkk-flood-map)';

const NEWS_QUERIES = [
  'น้ำท่วม กรุงเทพ',
  'น้ำท่วมขัง กทม',
  'ฝนตกหนัก กรุงเทพ น้ำท่วม',
  'น้ำรอระบาย กทม',
  'ระดับน้ำ เจ้าพระยา กรุงเทพ',
];
const NEWS_WINDOW_H = 48;
const MAX_AI_ITEMS_PER_RUN = 40;
const MAX_OUTPUT_ITEMS = 80; // จำกัดจำนวนที่แสดง ไม่ให้แผนที่รก
// YouTube search.list ใช้ 100 หน่วยต่อครั้ง โควต้าฟรี 10,000 หน่วย/วัน
// ค้นทุก 30 นาที = 48 ครั้ง/วัน ≈ 4,800 หน่วย เหลือเผื่อการกดรันเอง
const YT_QUERY = 'น้ำท่วม กรุงเทพ|น้ำท่วม กทม|น้ำท่วมขัง กทม|ฝนตกหนัก กรุงเทพ';
const YT_MIN_INTERVAL_MIN = 29;
// กรอบพิกัด กทม. (lng/lat) ใช้จำกัดผล geocode
const BKK_VIEWBOX = [100.32, 13.96, 100.94, 13.49];

const now = new Date();
const log = (...a) => console.log('[update]', ...a);

// ---------- helpers ----------
async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, obj) {
  await writeFile(path.join(DATA, file), JSON.stringify(obj, null, 1) + '\n');
}
async function fetchText(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const decodeEntities = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const stripTags = (s) => decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decodeEntities(m[1]).trim() : ''; };
function distKm(a, b, c, d) {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

// ---------- ข่าวจาก Google News RSS ----------
async function fetchNews() {
  const items = new Map();
  let failed = 0;
  for (const q of NEWS_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=th&gl=TH&ceid=TH:th`;
    try {
      const xml = await fetchText(url);
      for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const rawTitle = tag(body, 'title');
        const source = tag(body, 'source');
        const title = source && rawTitle.endsWith(' - ' + source) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
        const link = tag(body, 'link');
        const pub = new Date(tag(body, 'pubDate'));
        if (!title || !link || isNaN(pub) || now - pub > NEWS_WINDOW_H * 36e5) continue;
        // ข่าวเดียวกันจากหลายคำค้นให้นับครั้งเดียว (ใช้หัวข่าวเป็นหลัก)
        const id = sha(title.replace(/\s+/g, ''));
        if (!items.has(id)) items.set(id, { id, title, source, link, published: pub.toISOString(), snippet: stripTags(tag(body, 'description')).slice(0, 300) });
      }
    } catch (e) { failed++; log('news query failed:', q, e.message); }
  }
  // ถ้าดึงไม่ได้เลยสักคำค้น อย่าเขียนทับไฟล์ข่าวเดิมด้วยรายการว่าง
  if (failed === NEWS_QUERIES.length) throw new Error('ดึง Google News ไม่ได้ทุกคำค้น');
  return [...items.values()].sort((a, b) => b.published.localeCompare(a.published));
}

// ---------- คลิปจาก YouTube Data API v3 ----------
async function fetchYoutube() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { status: 'no-key', items: [] };
  const state = await readJSON('yt-state.json', { lastFetch: null, items: [] });
  const fresh = (items) => items.filter((v) => now - new Date(v.published) <= NEWS_WINDOW_H * 36e5);
  // ยังไม่ครบรอบ 30 นาที ใช้ผลค้นครั้งก่อน เพื่อประหยัดโควต้า
  if (state.lastFetch && now - new Date(state.lastFetch) < YT_MIN_INTERVAL_MIN * 60e3) {
    return { status: 'ok', items: fresh(state.items), cachedAt: state.lastFetch };
  }
  const url = 'https://www.googleapis.com/youtube/v3/search?' + new URLSearchParams({
    part: 'snippet', q: YT_QUERY, type: 'video', order: 'date', maxResults: '25',
    publishedAfter: new Date(now - NEWS_WINDOW_H * 36e5).toISOString(),
    regionCode: 'TH', relevanceLanguage: 'th', safeSearch: 'moderate', key,
  });
  try {
    const json = JSON.parse(await fetchText(url, {}, 30000));
    const items = (json.items || []).filter((v) => v.id && v.id.videoId).map((v) => ({
      id: 'yt-' + v.id.videoId,
      kind: 'youtube',
      videoId: v.id.videoId,
      title: decodeEntities(v.snippet.title),
      source: decodeEntities(v.snippet.channelTitle),
      link: 'https://www.youtube.com/watch?v=' + v.id.videoId,
      published: new Date(v.snippet.publishedAt).toISOString(),
      snippet: decodeEntities(v.snippet.description || '').slice(0, 300),
      thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
      live: v.snippet.liveBroadcastContent === 'live',
    }));
    await writeJSON('yt-state.json', { lastFetch: now.toISOString(), items });
    return { status: 'ok', items };
  } catch (e) {
    log('youtube failed:', e.message);
    // ค้นไม่สำเร็จ (เช่นโควต้าหมด) ใช้ผลเดิมไปก่อน
    return { status: 'error: ' + e.message, items: fresh(state.items || []) };
  }
}

// ---------- สรุปข่าวด้วย Gemini (free tier) ----------
async function analyzeWithGemini(batch, districtNames) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !batch.length) return {};
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const prompt = `คุณคือผู้ช่วยสรุปสถานการณ์น้ำท่วมในกรุงเทพมหานคร
อ่านรายการข่าวและคลิปวิดีโอต่อไปนี้ (หัวข้อ + ข้อความย่อ/คำอธิบายคลิป) แล้วตอบเป็น JSON array เท่านั้น หนึ่ง object ต่อข่าว ตามรูปแบบ:
{"id": string, "relevant": boolean, "summary": string, "severity": "สูง"|"กลาง"|"ต่ำ", "places": [{"name": string, "district": string}]}

กติกา:
- relevant = true เฉพาะข่าว/คลิปที่รายงานน้ำท่วม/น้ำขัง/ฝนตกหนัก/ระดับน้ำ "ในพื้นที่กรุงเทพมหานคร" ที่เป็นสถานการณ์ปัจจุบัน
- summary = สรุปภาษาไทยไม่เกิน 2 ประโยค ใช้เฉพาะข้อมูลที่อยู่ในข้อความ ห้ามเดาตัวเลขหรือสถานที่
- คลิปที่เป็นเพลง เกม รีวิว ละคร หรือเหตุการณ์ในอดีต ให้ relevant = false
- severity: สูง = ถนนสัญจรไม่ได้/น้ำเข้าบ้าน/มีผู้ได้รับผลกระทบมาก, กลาง = น้ำท่วมขังผ่านได้ลำบาก, ต่ำ = เตือนภัย/เล็กน้อย/น้ำลดแล้ว
- places = สถานที่ใน กทม. ที่ข่าวระบุชัดเจน (ถนน ซอย แยก ชุมชน) name ต้องเป็นชื่อที่ค้นบนแผนที่ได้ เช่น "ถนนสุขุมวิท ซอย 71"
- district = ชื่อเขตโดยไม่มีคำว่า "เขต" ต้องเป็นหนึ่งใน: ${districtNames.join(', ')} ถ้าไม่ทราบให้เป็น ""
- ถ้าข่าวไม่ระบุสถานที่ให้ places เป็น []

ข่าว:
${batch.map((n) => JSON.stringify({ id: n.id, title: n.title, snippet: n.snippet })).join('\n')}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  // free tier มักตอบ 503 (โมเดลคนใช้เยอะ) หรือ 429 (เกินโควต้าต่อนาที): ลองซ้ำ แล้วสลับไปรุ่นสำรอง
  const models = [...new Set([model, 'gemini-flash-lite-latest'])];
  let text = null, lastErr = null;
  for (const m of models) {
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        text = await fetchText(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body,
        }, 90000);
      } catch (e) {
        lastErr = e;
        log(`gemini ${m} attempt ${attempt + 1} failed:`, e.message);
        if (!/HTTP (429|500|502|503|504)|abort/i.test(e.message)) break; // เช่น 400/403/404 ลองซ้ำไม่ช่วย
        await sleep(3000 * 2 ** attempt);
      }
    }
    if (text) break;
  }
  if (!text) throw lastErr;
  const out = JSON.parse(text);
  const raw = out?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '[]';
  const arr = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
  const res = {};
  for (const r of Array.isArray(arr) ? arr : []) if (r && r.id) res[r.id] = r;
  return res;
}

// ---------- วิเคราะห์แบบไม่ใช้ AI (fallback) ----------
const FLOOD_RE = /ท่วม|น้ำขัง|น้ำรอระบาย|ฝนตกหนัก|ระดับน้ำ|ล้นตลิ่ง/;
const BKK_RE = /กรุงเทพ|กทม|กรุงเทพฯ|bangkok/i;
function analyzeByKeywords(n, districts) {
  // ไม่มี AI: ใช้เฉพาะ "หัวข้อ" เพื่อลดข่าวที่ไม่เกี่ยว (ข้อความย่อมักมีคำกว้าง ๆ ปนมา)
  const title = n.title;
  const hits = districts.filter((d) => title.includes('เขต' + d.name) || (d.name.length >= 4 && title.includes(d.name)));
  const relevant = /ท่วม|น้ำขัง|น้ำรอระบาย/.test(title) && (BKK_RE.test(title) || hits.length > 0)
    && !/จ\.\s?\S+|จังหวัด(?!กรุงเทพ)/.test(title.replace(/กรุงเทพมหานคร/g, ''));
  let severity = 'กลาง';
  if (/ผ่านไม่ได้|สัญจรไม่ได้|ปิดถนน|เข้าบ้าน|อพยพ|วิกฤต|หนักสุด/.test(title)) severity = 'สูง';
  else if (/เตือน|เฝ้าระวัง|คลี่คลาย|น้ำลด|ระบายแล้ว/.test(title)) severity = 'ต่ำ';
  return { id: n.id, relevant, summary: '', severity, places: hits.map((d) => ({ name: '', district: d.name })), ai: false };
}

// ---------- geocode ด้วย OpenStreetMap Nominatim (ฟรี, จำกัด 1 ครั้ง/วินาที) ----------
async function geocode(name, cache) {
  if (!name) return null;
  if (name in cache) return cache[name];
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: name + ' กรุงเทพมหานคร', format: 'json', limit: '1', countrycodes: 'th',
    viewbox: BKK_VIEWBOX.join(','), bounded: '1', 'accept-language': 'th',
  });
  let hit = null;
  try {
    const arr = JSON.parse(await fetchText(url, {}, 20000));
    if (arr[0]) hit = { lat: +(+arr[0].lat).toFixed(5), lng: +(+arr[0].lon).toFixed(5) };
  } catch (e) { log('geocode failed:', name, e.message); await sleep(1100); return null; }
  cache[name] = hit;
  await sleep(1100);
  return hit;
}

function pinsFor(analysis, districts, geo) {
  const pins = [];
  for (const p of analysis.places || []) {
    const d = districts.find((x) => x.name === String(p.district || '').replace(/^เขต/, '').trim());
    const g = p.name ? geo[p.name] : null;
    // ใช้ตำแหน่งจาก geocode ถ้าอยู่ใกล้เขตที่ข่าวระบุ ไม่งั้นใช้จุดกึ่งกลางเขต
    if (g && (!d || distKm(g.lat, g.lng, d.lat, d.lng) < 8)) pins.push({ lat: g.lat, lng: g.lng, label: p.name, precision: 'place', district: d?.name || '' });
    else if (d) pins.push({ lat: d.lat, lng: d.lng, label: p.name || 'เขต' + d.name, precision: 'district', district: d.name });
  }
  const seen = new Set();
  return pins.filter((p) => { const k = p.lat + ',' + p.lng; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function updateNews(meta) {
  const districts = await readJSON('districts.json', []);
  const cache = await readJSON('news-cache.json', {}); // ผลวิเคราะห์เดิม เพื่อไม่เรียก AI ซ้ำ
  const geo = await readJSON('geocache.json', {});
  const prev = await readJSON('news.json', { items: [] });
  let newsErr = null;
  let newsItems = await fetchNews().catch((e) => { newsErr = e; return null; });
  // Google News ล่มทั้งหมด: ใช้ข่าวรอบก่อนแทน (ผลวิเคราะห์ยังอยู่ใน cache)
  if (!newsItems) newsItems = (prev.items || []).filter((n) => n.kind !== 'youtube' && now - new Date(n.published) <= NEWS_WINDOW_H * 36e5)
    .map(({ summary, severity, ai, pins, ...n }) => n);
  const yt = await fetchYoutube();
  if (newsErr && !yt.items.length) throw newsErr;
  const items = [...newsItems.map((n) => ({ kind: 'news', ...n })), ...yt.items]
    .sort((a, b) => b.published.localeCompare(a.published));
  log('news items:', newsItems.length, 'youtube items:', yt.items.length);

  const hasKey = !!process.env.GEMINI_API_KEY;
  const todo = items.filter((n) => !cache[n.id] || (hasKey && !cache[n.id].ai)).slice(0, MAX_AI_ITEMS_PER_RUN);
  let aiStatus = hasKey ? 'ok' : 'no-key';
  if (hasKey && todo.length) {
    try {
      for (let i = 0; i < todo.length; i += 20) {
        const res = await analyzeWithGemini(todo.slice(i, i + 20), districts.map((d) => d.name));
        for (const n of todo.slice(i, i + 20)) if (res[n.id]) cache[n.id] = { ...res[n.id], ai: true, at: now.toISOString() };
      }
    } catch (e) { aiStatus = 'error: ' + e.message; log('gemini failed:', e.message); }
  }
  for (const n of items) if (!cache[n.id] || !cache[n.id].ai) cache[n.id] = { ...analyzeByKeywords(n, districts), at: cache[n.id]?.at || now.toISOString() };

  const out = [];
  for (const n of items) {
    if (out.length >= MAX_OUTPUT_ITEMS) break;
    const a = cache[n.id];
    if (!a.relevant) continue;
    for (const p of a.places || []) if (p.name) await geocode(p.name, geo);
    out.push({ ...n, summary: a.summary || '', severity: a.severity || 'กลาง', ai: !!a.ai, pins: pinsFor(a, districts, geo) });
  }

  // ล้าง cache ที่เก่ากว่า 4 วัน
  const keep = new Set(items.map((n) => n.id));
  for (const [k, v] of Object.entries(cache)) if (!keep.has(k) && now - new Date(v.at) > 4 * 864e5) delete cache[k];

  await writeJSON('news.json', { updated: now.toISOString(), items: out });
  await writeJSON('news-cache.json', cache);
  await writeJSON('geocache.json', geo);
  meta.sources.news = { ok: !newsErr, count: out.filter((n) => n.kind === 'news').length, fetched: newsItems.length, ai: aiStatus, ...(newsErr ? { error: newsErr.message } : {}) };
  meta.sources.youtube = { ok: yt.status === 'ok', status: yt.status, count: out.filter((n) => n.kind === 'youtube').length, fetched: yt.items.length };
}

// ---------- ประกาศเตือนภัยกรมอุตุนิยมวิทยา ----------
function findRecords(node, out = []) {
  if (Array.isArray(node)) { node.forEach((x) => findRecords(x, out)); return out; }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node).map((k) => k.toLowerCase());
    if (keys.some((k) => k.includes('title'))) out.push(node);
    else Object.values(node).forEach((v) => findRecords(v, out));
  }
  return out;
}
const pickField = (o, re) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? String(o[k] ?? '').trim() : ''; };

async function updateTmd(meta) {
  const uid = process.env.TMD_UID || 'demo';
  const ukey = process.env.TMD_UKEY || 'demokey';
  const url = `https://data.tmd.go.th/api/WeatherWarningNews/v2/?uid=${encodeURIComponent(uid)}&ukey=${encodeURIComponent(ukey)}&format=json`;
  try {
    const json = JSON.parse(await fetchText(url, {}, 30000));
    const items = findRecords(json).map((r) => ({
      title: stripTags(pickField(r, /^title.*th|^titlethai$/i) || pickField(r, /title/i)),
      description: stripTags(pickField(r, /^desc.*th|^descriptionthai$/i) || pickField(r, /desc/i)).slice(0, 1200),
      announced: pickField(r, /announce|date|time/i),
      file: pickField(r, /file|url|link/i),
    })).filter((x) => x.title);
    await writeJSON('tmd.json', { updated: now.toISOString(), items: items.slice(0, 10) });
    meta.sources.tmd = { ok: true, count: items.length, demo: uid === 'demo' };
  } catch (e) {
    log('tmd failed:', e.message);
    meta.sources.tmd = { ok: false, error: e.message }; // เก็บไฟล์เดิมไว้ ไม่เขียนทับ
  }
}

// ---------- ตรวจระบบรับแจ้งจากประชาชน (Google Apps Script) ว่ายังตอบได้ ----------
async function checkReports(meta) {
  let ep = '';
  try { ep = JSON.parse(await readFile(path.join(DATA, 'report-config.json'), 'utf8')).endpoint || ''; } catch { /* ไม่มีไฟล์ */ }
  if (!ep) { meta.sources.reports = { ok: false, status: 'not-configured' }; return; }
  try {
    const d = JSON.parse(await fetchText(ep + '?action=list', {}, 30000));
    if (!d.ok) throw new Error(d.error || 'ตอบกลับไม่ถูกต้อง');
    meta.sources.reports = { ok: true, open: (d.reports || []).filter((r) => r.status === 'open').length };
  } catch (e) {
    log('reports endpoint failed:', e.message);
    meta.sources.reports = { ok: false, error: e.message };
  }
}

// ---------- main ----------
await mkdir(DATA, { recursive: true });
const meta = { updated: now.toISOString(), sources: {} };
await updateNews(meta).catch((e) => { log('news failed:', e); meta.sources.news = { ok: false, error: e.message }; meta.sources.youtube ??= { ok: false, error: e.message }; });
await updateTmd(meta);
await checkReports(meta);
await writeJSON('meta.json', meta);
log('done', JSON.stringify(meta));
