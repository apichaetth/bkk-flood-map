// ดึงข่าวน้ำท่วม กทม. + ประกาศเตือนภัยกรมอุตุฯ แล้วเขียนไฟล์ JSON ลง data/
// รันโดย GitHub Actions ทุก 15 นาที (ดู .github/workflows/update-data.yml)
// ใช้ Node 22+ ไม่มี dependency ภายนอก
//
// env ที่ใช้ได้ (ตั้งเป็น GitHub Secrets):
//   GEMINI_API_KEY  – key ฟรีจาก https://aistudio.google.com/apikey (ไม่มีก็ทำงานได้ แต่ไม่มีสรุปด้วย AI)
//   GEMINI_MODEL    – ค่าเริ่มต้น gemini-flash-latest
//   TMD_TOKEN       – token ของ TMD NWP API (data.tmd.go.th/nwpapi) สำหรับพยากรณ์ฝนรายชั่วโมงรายเขต
//   TMD_UID, TMD_UKEY – key กรมอุตุฯ จาก https://data.tmd.go.th/api/index1.php (ไม่มีจะใช้ demo)
//   YOUTUBE_API_KEY – key ฟรีจาก Google Cloud (YouTube Data API v3) ไม่มีก็ข้ามส่วนคลิป

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadRoads, scoreRoads, evalUpdate, newEvalState, packSegments, isMain } from './risk.mjs';
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
const MAX_AI_ITEMS_PER_RUN = 10; // free tier จำกัดคำขอต่อนาที/วัน: สรุปเฉพาะข่าวใหม่สุดรอบละ 10 เรื่อง (ส่งครั้งเดียว)
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
// เขียนแบบไม่เว้นบรรทัด: ไฟล์ที่มีพิกัดจำนวนมาก (เช่น risk-roads.json) เล็กลงหลายเท่า เบราว์เซอร์โหลดเร็วขึ้น
async function writeJSON(file, obj) {
  const text = JSON.stringify(obj) + '\n';
  await writeFile(path.join(DATA, file), text);
  if (text.length > 300000) log(`${file}: ${(Buffer.byteLength(text) / 1e6).toFixed(2)} MB`);
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
        // 429 = โควต้าหมด รอไม่กี่วินาทีไม่ช่วย ข้ามไปรุ่นสำรองทันที; 400/403/404 ลองซ้ำก็ไม่ช่วย
        if (!/HTTP (500|502|503|504)|abort/i.test(e.message)) break;
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
  // ข่าวเรียงใหม่→เก่าอยู่แล้ว เลือกเฉพาะที่ยังไม่ได้สรุปและไม่เก่าเกิน 24 ชม. (ข่าวเก่าใช้การวิเคราะห์ด้วยคำสำคัญ)
  const fresh = (n) => now - new Date(n.published) <= 24 * 36e5;
  const todo = hasKey ? items.filter((n) => fresh(n) && !(cache[n.id] && cache[n.id].ai)).slice(0, MAX_AI_ITEMS_PER_RUN) : [];
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
    // ข้ามส่วนหัวของ feed (เช่น "Thailand Weather and Climate News") ที่ไม่มีเนื้อหาประกาศ
    const records = findRecords(json).filter((r) => Object.keys(r).some((k) => /desc/i.test(k) && String(r[k] || '').trim())
      && !/weather and climate news/i.test(pickField(r, /title/i)));
    const items = records.map((r) => ({
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

// ---------- Traffy Fondue: เรื่องแจ้งน้ำท่วม (เบราว์เซอร์ดึงตรงไม่ได้เพราะติด CORS จึงดึงที่นี่แล้วเก็บเป็นไฟล์) ----------
// สะสมข้ามรอบ: 7 วันล่าสุดใน traffy.json (ทุกหน้าใช้) และวันที่ 8–30 ใน traffy-archive.json (หน้า Traffy โหลดเมื่อเลือกช่วงยาว)
// (API ให้ครั้งละไม่เกิน ~1000 เรื่องล่าสุด ดึงย้อนหลังเองไม่ได้ จึงต้องสะสมไปเรื่อย ๆ)
const TRAFFY_API = 'https://publicapi.traffy.in.th/share/teamchadchart/search';
const TRAFFY_KEEP_D = 7, TRAFFY_ARCHIVE_D = 30;
const T_FLOOD_RE = /น้ำท่วม|ท่วมขัง|ท่วมถนน|น้ำขัง|น้ำรอระบาย|รอการระบาย|น้ำเจิ่ง/;
const T_NOT_FLOOD_RE = /ประปา|น้ำไม่ไหล|ท่อแตก|ท่อรั่ว|น้ำรั่ว|น้ำเสีย|กลิ่น|ยุง/;
function isFloodTicket(r) {
  const types = [].concat(r.problem_type_abdul || [], r.type ? String(r.type).replace(/[{}]/g, '').split(',') : [])
    .map((t) => String(t).trim()).filter(Boolean);
  if (types.length) return types.includes('น้ำท่วม');
  const d = String(r.description || '');
  return T_FLOOD_RE.test(d) && !T_NOT_FLOOD_RE.test(d);
}
async function updateTraffy(meta) {
  const prev = await readJSON('traffy.json', { results: [] });
  let d = null, lastErr = null;
  // 1000 เรื่องมักหมดเวลา (~90 วินาที) ใช้ 500 ต่อรอบก็พอ เพราะสะสมข้ามรอบอยู่แล้ว
  for (const lim of [500, 300]) {
    try { d = JSON.parse(await fetchText(`${TRAFFY_API}?limit=${lim}`, {}, 60000)); if (Array.isArray(d.results) && d.results.length) break; d = null; }
    catch (e) { lastErr = e; d = null; }
  }
  if (!d) { log('traffy failed:', lastErr && lastErr.message); meta.sources.traffy = { ok: false, error: lastErr ? lastErr.message : 'empty' }; return; }
  const fresh = d.results.filter((r) => r.ticket_id && r.coords && isFloodTicket(r)).map((r) => ({
    ticket_id: r.ticket_id, timestamp: r.timestamp, coords: r.coords, state: r.state,
    description: String(r.description || '').slice(0, 500), address: r.address || '', photo_url: r.photo_url || '',
    problem_type_abdul: r.problem_type_abdul || [],
  }));
  // รวมกับรอบก่อน: เรื่องเดิมใช้ข้อมูลใหม่ (สถานะอาจเปลี่ยน) และตัดที่เก่ากว่า 7 วัน
  const byId = new Map((prev.results || prev.items || []).map((x) => [x.ticket_id, x]));
  for (const x of fresh) byId.set(x.ticket_id, x);
  const cutoff = now - TRAFFY_KEEP_D * 864e5;
  const ts = (x) => new Date(String(x.timestamp).replace(' ', 'T').replace(/\+00$/, 'Z')).getTime();
  const items = [...byId.values()].filter((x) => ts(x) >= cutoff).sort((a, b) => ts(b) - ts(a));
  // เรื่องที่เก่ากว่า 7 วันย้ายไปเก็บในไฟล์ย้อนหลัง (ย่อข้อความให้ไฟล์เล็ก)
  const arch = await readJSON('traffy-archive.json', { results: [] });
  const aById = new Map((arch.results || []).map((x) => [x.ticket_id, x]));
  for (const x of byId.values()) if (ts(x) < cutoff) aById.set(x.ticket_id, { ...x, description: String(x.description || '').slice(0, 200) });
  const aCut = now - TRAFFY_ARCHIVE_D * 864e5;
  const aItems = [...aById.values()].filter((x) => ts(x) >= aCut && ts(x) < cutoff).sort((a, b) => ts(b) - ts(a));
  const aSince = Math.min(...[arch.since ? new Date(arch.since).getTime() : Infinity, ...aItems.map(ts)].filter(isFinite));
  await writeJSON('traffy-archive.json', { updated: now.toISOString(), since: isFinite(aSince) ? new Date(Math.max(aSince, aCut)).toISOString() : null, results: aItems });
  const times = d.results.map(ts).filter((t) => !isNaN(t));
  const oldestFetched = times.length ? Math.min(...times) : null;
  // prev.since เชื่อได้เฉพาะไฟล์ที่สะสมถูกต้องแล้ว (acc: 2) — ไฟล์รุ่นก่อนหน้าไม่ได้สะสมจริง
  const prevSince = prev.acc === 2 && prev.since ? new Date(prev.since).getTime() : Infinity;
  const since = Math.min(...[oldestFetched, prevSince].filter((v) => v != null && isFinite(v)));
  await writeJSON('traffy.json', { acc: 2, updated: now.toISOString(), fetched: d.results.length, since: isFinite(since) ? new Date(Math.max(since, cutoff)).toISOString() : null, results: items });
  meta.sources.traffy = { ok: true, fetched: d.results.length, flood: fresh.length, kept: items.length };
}

// ---------- สำรองรายชื่อกล้อง CCTV และภาพเรดาร์ล่าสุด (ใช้เมื่อเบราว์เซอร์ดึงตรงไม่ได้) ----------
async function updateCamsRadar(meta) {
  try {
    const cams = JSON.parse(await fetchText('https://camera.longdo.com/feed/?command=json', {}, 45000));
    const keep = (Array.isArray(cams) ? cams : []).filter((c) => {
      const la = +c.latitude, lo = +c.longitude;
      return la >= 13.48 && la <= 13.97 && lo >= 100.32 && lo <= 100.95 && /^https:\/\//.test(c.hls_url || '') && !/tempsus/.test(c.hls_url);
    }).map((c) => ({ camid: c.camid, title: c.title, latitude: c.latitude, longitude: c.longitude, hls_url: c.hls_url, imgurl: c.imgurl, organization: c.organization, sponsertext: c.sponsertext }));
    if (keep.length) await writeJSON('cams.json', { updated: now.toISOString(), cams: keep });
    meta.sources.cams = { ok: true, count: keep.length };
  } catch (e) { log('cams failed:', e.message); meta.sources.cams = { ok: false, error: e.message }; }
  try {
    const d = JSON.parse(await fetchText('https://api.rainviewer.com/public/weather-maps.json', {}, 20000));
    await writeJSON('radar.json', d);
    meta.sources.radar = { ok: true };
  } catch (e) { log('radar failed:', e.message); meta.sources.radar = { ok: false, error: e.message }; }
}

// ---------- กรมอุตุฯ พยากรณ์ฝนรายชั่วโมงรายเขต (NWP API ใช้ token ใน secret TMD_TOKEN) ----------
async function updateTmdForecast(meta) {
  const token = (process.env.TMD_TOKEN || '').trim();
  if (!token) { meta.sources.tmdFcst = { ok: false, status: 'no-key' }; return; }
  const API = 'https://data.tmd.go.th/nwpapi/v1/forecast/';
  const hdr = { accept: 'application/json', authorization: 'Bearer ' + token };
  // เวลาเริ่ม = ชั่วโมงปัจจุบันตามเวลาไทย
  const bkk = new Date(now.getTime() + 7 * 36e5);
  const start = bkk.toISOString().slice(0, 13) + ':00:00';
  const end = new Date(bkk.getTime() + 23 * 36e5).toISOString().slice(0, 13) + ':00:00';
  const tries = [
    `area/place?domain=2&province=${encodeURIComponent('กรุงเทพมหานคร')}&fields=rain,cond,tc&starttime=${start}&endtime=${end}`,
    `area/place?domain=2&province=${encodeURIComponent('กรุงเทพมหานคร')}&fields=rain,cond,tc&starttime=${start}&duration=24`,
    `area/place?domain=2&province=${encodeURIComponent('กรุงเทพมหานคร')}&fields=rain,cond,tc&starttime=${start}`,
    `location/hourly/at?lat=13.75&lon=100.5&fields=rain,cond,tc&duration=24`,
  ];
  let j = null, used = '', lastErr = null;
  for (const q of tries) {
    try { j = JSON.parse(await fetchText(API + q, { headers: hdr }, 60000)); used = q.split('?')[0]; if ((j.WeatherForecasts || []).length) break; }
    catch (e) { lastErr = e; log('tmd forecast', q.split('?')[0], 'failed:', e.message); j = null; }
  }
  if (!j || !(j.WeatherForecasts || []).length) { meta.sources.tmdFcst = { ok: false, error: lastErr ? lastErr.message : 'empty' }; return; }
  const first = j.WeatherForecasts[0];
  log('tmd forecast via', used, 'locations:', j.WeatherForecasts.length, 'sample:', JSON.stringify(first).slice(0, 400));
  const areas = j.WeatherForecasts.map((w) => {
    const L = w.location || {};
    const hours = (w.forecasts || []).map((f) => ({ t: f.time, rain: +((f.data || {}).rain ?? 0), cond: (f.data || {}).cond ?? null, tc: (f.data || {}).tc ?? null }));
    return { name: L.amphoe || L.name || L.province || '', la: +L.lat || null, lo: +L.lon || null, hours };
  }).filter((a) => a.hours.length);
  const sum = (a, n) => a.hours.slice(0, n).reduce((x, h) => x + (h.rain || 0), 0);
  for (const a of areas) { a.r3 = +sum(a, 3).toFixed(1); a.r6 = +sum(a, 6).toFixed(1); a.r24 = +sum(a, 24).toFixed(1); }
  await writeJSON('tmd-forecast.json', { updated: now.toISOString(), via: used, areas });
  meta.sources.tmdFcst = { ok: true, areas: areas.length, hours: areas[0] ? areas[0].hours.length : 0 };
}

// ---------- ThaiWater: เขื่อนลุ่มเจ้าพระยา + พยากรณ์ฝน (thailand_main ไฟล์ใหญ่ ~8 MB จึงดึงที่นี่ ไม่ให้เบราว์เซอร์โหลด) ----------
const CPY_DAMS = ['ภูมิพล', 'สิริกิติ์', 'แควน้อยบำรุงแดน', 'ป่าสักชลสิทธิ์', 'ทับเสลา', 'กระเสียว'];
async function updateThaiwater(meta) {
  const TWI = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/';
  const hdr = { Referer: 'https://www.thaiwater.net/' };
  try {
    const j = JSON.parse(await fetchText(TWI + 'public/thailand_main', { headers: hdr }, 120000));
    const dig = (o, ...k) => k.reduce((a, x) => (a == null ? a : a[x]), o);
    const dams = (dig(j, 'dam', 'data', 'data') || []).filter((d) => CPY_DAMS.includes(dig(d, 'dam', 'dam_name', 'th')))
      .sort((a, b) => CPY_DAMS.indexOf(a.dam.dam_name.th) - CPY_DAMS.indexOf(b.dam.dam_name.th))
      .map((d) => ({ name: d.dam.dam_name.th, date: d.dam_date, pct: d.dam_storage_percent, storage: d.dam_storage, max: d.dam.max_storage,
        inflow: d.dam_inflow, released: d.dam_released, spilled: d.dam_spilled, uses: d.dam_uses_water, province: dig(d, 'geocode', 'province_name', 'th') || '' }));
    const heavy = (dig(j, 'warning', 'temp_data2', 'data') || []).map((p) => ({ code: String(p.province_code), name: dig(p, 'province_name', 'th') || '', level: p.rainforecast_level }));
    // ภาพพยากรณ์ฝน: ดาวน์โหลดมาเก็บในเว็บเรา (ลิงก์ของ ThaiWater อาจเปิดจากเว็บอื่นไม่ได้)
    await mkdir(path.join(DATA, 'tw'), { recursive: true });
    const images = [];
    for (const [key, label] of [['pre_rain', 'ประเทศไทย'], ['pre_rain_basin', 'รายลุ่มน้ำ']]) {
      const list = (dig(j, key, 'data', 'data') || []).slice(0, 3);
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m.media_path) continue;
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
          const r = await fetch(TWI + 'shared/image?image=' + encodeURIComponent(m.media_path), { headers: { ...hdr, 'User-Agent': UA }, signal: ctl.signal });
          clearTimeout(t);
          if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          const file = `tw/${key}-${i + 1}.jpg`;
          await writeFile(path.join(DATA, file), buf);
          images.push({ group: label, file: 'data/' + file, name: m.filename, datetime: m.media_datetime, day: +((String(m.filename).match(/day0?(\d+)/) || [])[1] || i + 1) });
        } catch (e) { log('thaiwater image failed:', m.filename, e.message); }
      }
    }
    // พายุ: ThaiWater ให้เป็นภาพแผนที่ติดตามพายุจากหลายแหล่ง ดาวน์โหลดภาพล่าสุดของแต่ละแหล่ง
    const storms = [];
    const stormData = dig(j, 'storm', 'data', 'data') || {};
    for (const key of ['typhoon', 'us', 'college']) {
      const m = [].concat(stormData[key] || [])[0];
      if (!m || !m.media_path) continue;
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
        const r = await fetch(TWI + 'shared/image?image=' + encodeURIComponent(m.media_path), { headers: { ...hdr, 'User-Agent': UA }, signal: ctl.signal });
        clearTimeout(t);
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\//.test(ct)) continue;
        const file = `tw/storm-${key}.${/png/.test(ct) ? 'png' : 'jpg'}`;
        await writeFile(path.join(DATA, file), Buffer.from(await r.arrayBuffer()));
        storms.push({ key, file: 'data/' + file, datetime: m.media_datetime, source: m.refer_source || '', name: m.filename });
      } catch (e) { log('storm image failed:', key, e.message); }
    }
    await writeJSON('thaiwater.json', { updated: now.toISOString(), dams, heavy, images, storms });
    meta.sources.thaiwater = { ok: true, dams: dams.length, heavy: heavy.length, images: images.length, storms: storms.length };
  } catch (e) { log('thaiwater failed:', e.message); meta.sources.thaiwater = { ok: false, error: e.message }; }
}

// ---------- ประมาณการถนนที่มีแนวโน้มน้ำท่วม (ทดลอง) ดู scripts/risk.mjs ----------
const bkkTime = (s) => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/); return m ? new Date(`${m[1]}T${m[2]}:00+07:00`).getTime() : NaN; };
const utcTime = (s) => new Date(String(s || '').replace(' ', 'T').replace(/\+00$/, 'Z')).getTime();
const WEB_LV = { 'ข้อเท้า': 1, 'ครึ่งแข้ง': 2, 'เข่า': 3, 'เอว': 3, 'สูงกว่าเอว': 3, 'ไม่ระบุ': 2 };
async function updateRisk(meta) {
  const src = {};
  // ถ้าโหลดเครือข่ายถนนไม่ได้ ยังเก็บข้อมูลฝน/ระดับน้ำ (tw-rain/tw-wl) ต่อ แค่ข้ามการคำนวณ
  let roads = null;
  try { roads = await loadRoads(DATA, fetchText, log); }
  catch (e) { log('roads failed:', e.message); }
  const inBkk = (la, lo) => la >= 13.4 && la <= 14.05 && lo >= 100.25 && lo <= 101.0;
  const reports = [], history = [], rain = [], wl = [], fc = [];
  const lvOf = (cm) => (cm >= 15 ? 3 : cm >= 10 ? 2 : 1);
  const fresh = (t, h) => t && now - t <= h * 36e5;
  const seenCode = new Set(), seenCanal = new Set(); // จุดที่ได้จากเครื่องในไทยแล้ว ไม่ใช้ซ้ำจาก ThaiWater
  let relay = null;
  const alertOnly = []; // เซ็นเซอร์จากระบบแจ้งเตือน (ลำดับความสำคัญต่ำสุด: DDS > ThaiWater > แจ้งเตือน)
  // เซ็นเซอร์น้ำท่วมถนน กทม.: เครื่องในไทย (scripts/bma-fetch.mjs) ส่งขึ้น branch bma-data ทุก 15 นาที
  // เพราะเซิร์ฟเวอร์ กทม. ปฏิเสธเครื่องนอกประเทศ (รวม GitHub Actions)
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'apichaetth/bkk-flood-map';
    const b = JSON.parse(await fetchText(`https://raw.githubusercontent.com/${repo}/bma-data/bma-sensors.json?t=${now.getTime()}`, {}, 20000));
    const age = now - Date.parse(b.updated);
    if (!(age <= 60 * 6e4)) throw new Error(`ข้อมูลเก่า ${Math.round(age / 6e4)} นาที (เครื่องในไทยอาจปิดอยู่)`);
    relay = b;
    // เซ็นเซอร์ถนน: ใช้ระบบ DDS (มีสถานะปัจจุบัน) เป็นหลัก ระบบ floodbangkok เสริมจุดที่ DDS ไม่มี
    let flooded = 0;
    for (const x of b.road || []) {
      if (x.st === 'off') continue;
      seenCode.add(x.c);
      if (x.st !== 'flood' || !(x.cm >= 5) || !fresh(x.t, 3)) continue;
      flooded++;
      reports.push({ la: x.la, lo: x.lo, t: x.t, src: 'bma', lv: lvOf(x.cm) });
    }
    // ระบบแจ้งเตือน floodbangkok มีแค่จุดที่มีการแจ้งเตือน ใช้หลัง ThaiWater (ด้านล่าง) เฉพาะจุดที่ยังไม่มี
    for (const x of b.sensors || []) {
      if (x.cm == null || x.cm < 5 || !fresh(x.t, 3)) continue;
      alertOnly.push({ c: x.code, la: x.la, lo: x.lo, t: x.t, src: 'bma', lv: lvOf(x.cm) });
    }
    // ฝนจากสถานี กทม. (ถี่และใหม่กว่า) รวมกับ ThaiWater
    for (const x of b.rain || []) if (x.ok !== false && fresh(x.t, 1.5) && x.r1 != null) rain.push({ la: x.la, lo: x.lo, mm1: x.r1, mm24: x.r24 || 0 });
    // คลองตามสถานะของ กทม.: วิกฤต/เตือนภัย ส่งผลในรัศมีแคบ (300 ม.) และน้ำหนักต่ำ (วิกฤต 0.3 เตือนภัย 0.15) ไม่พอทำให้ติดระดับได้เอง ต้องมีฝนหรือรายงานประกอบ
    for (const x of b.canal || []) {
      if (fresh(x.t, 3) && x.st >= 0) seenCanal.add(x.c);
      if (x.st < 1 || !fresh(x.t, 3)) continue;
      wl.push({ la: x.la, lo: x.lo, pct: x.st === 2 ? 100 : 90, W: x.st === 2 ? 0.3 : 0.15, r: 300, name: x.n });
    }
    src.bma = (b.sensors || []).length + (b.road || []).length;
    meta.sources.bma = { ok: true, sensors: (b.sensors || []).length, road: (b.road || []).length, flooded,
      rain: (b.rain || []).length, canal: (b.canal || []).length, canalCritical: (b.canal || []).filter((x) => x.st === 2).length,
      ageMin: Math.round(age / 6e4), ...(b.errors && Object.keys(b.errors).length ? { partial: Object.keys(b.errors) } : {}) };
  } catch (e) {
    const msg = /HTTP 404/.test(e.message) ? 'ยังไม่มีเครื่องในไทยส่งข้อมูล' : e.message;
    src.bma = 'off: ' + msg;
    meta.sources.bma = { ok: false, error: msg };
  }
  // เซ็นเซอร์ถนน 262 จุด + คลอง 282 สถานีของ กทม. ผ่าน ThaiWater (เข้าได้จาก GitHub Actions ตลอด 24 ชม.)
  // ใช้เสริมจุดที่เครื่องในไทยไม่ได้ส่งมา และเป็นข้อมูลหลักเมื่อเครื่องในไทยปิด
  let twStations = [];
  try {
    const TWP = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/', H = { headers: { Referer: 'https://www.thaiwater.net/' } };
    const [fr, cw] = await Promise.all([fetchText(TWP + 'flood_road', H, 60000), fetchText(TWP + 'canal_waterlevel', H, 60000)].map((p) => p.then(JSON.parse)));
    const tx = (o) => (o && (o.th || o.en)) || '';
    const nm = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
    const road = [], canal = [];
    for (const x of fr.data || []) {
      const st = x.station || {}, la = +st.floodroad_lat, lo = +st.floodroad_long, code = st.floodroad_oldcode || '';
      if (!inBkk(la, lo)) continue;
      twStations.push({ id: st.id, c: code, la, lo });
      const t = bkkTime(x.floodroad_datetime), cm = nm(x.floodroad_value), live = fresh(t, 3) && cm != null;
      road.push({ c: code, n: tx(st.floodroad_name), road: '', d: tx(x.geocode && x.geocode.amphoe_name).replace(/^เขต/, ''), la, lo, t,
        st: !live ? 'off' : cm >= 5 ? 'flood' : 'ok', cm: live ? cm : null, tunnel: /^TN\./.test(code), dir: '' });
    }
    for (const x of cw.data || []) {
      const st = x.station || {}, la = +st.canal_lat, lo = +st.canal_long, warn = nm(st.warning_level), crit = nm(st.critical_level);
      if (!inBkk(la, lo) || warn == null || crit == null || crit <= warn) continue; // ไม่มีเกณฑ์ ใช้ไม่ได้
      const t = bkkTime(x.canal_datetime), v = nm(x.canal_value), live = fresh(t, 3) && v != null;
      canal.push({ c: st.canal_oldcode || '', n: tx(st.canal_name), river: '', d: tx(x.geocode && x.geocode.amphoe_name).replace(/^เขต/, ''), la, lo, t,
        wl: live ? v : null, warn, crit, st: !live ? -1 : v >= crit ? 2 : v >= warn ? 1 : 0 });
    }
    let flooded = 0;
    for (const x of road) {
      if (seenCode.has(x.c)) continue;
      if (x.st !== 'off') seenCode.add(x.c);
      if (x.st !== 'flood') continue;
      flooded++;
      reports.push({ la: x.la, lo: x.lo, t: x.t, src: 'bma', lv: lvOf(x.cm) });
    }
    for (const x of canal) {
      if (seenCanal.has(x.c) || x.st < 1) continue;
      wl.push({ la: x.la, lo: x.lo, pct: x.st === 2 ? 100 : 90, W: x.st === 2 ? 0.3 : 0.15, r: 300, name: x.n });
    }
    // หน้าเว็บใช้ไฟล์เดียวกัน: เครื่องในไทยเปิดอยู่ใช้ของเครื่องในไทย (ละเอียดกว่า มีฝน/อุโมงค์) ไม่งั้นใช้ของ ThaiWater
    if (!relay) await writeJSON('bma-sensors.json', { updated: now.toISOString(), source: 'thaiwater', errors: {}, sensors: [], rain: [], canal, road });
    meta.sources.bmaTw = { ok: true, road: road.length, live: road.filter((x) => x.st !== 'off').length, flooded,
      canal: canal.length, canalCritical: canal.filter((x) => x.st === 2).length, used: relay ? 'fill-gaps' : 'primary' };
  } catch (e) {
    log('thaiwater bma failed:', e.message);
    meta.sources.bmaTw = { ok: false, error: e.message };
  }
  for (const x of alertOnly) if (!seenCode.has(x.c)) { seenCode.add(x.c); reports.push(x); }
  if (relay) await writeJSON('bma-sensors.json', { ...relay, source: relay.source || 'relay' });
  // Traffy (สะสมไว้แล้วใน traffy.json)
  const tf = await readJSON('traffy.json', { results: [] });
  const tfa = await readJSON('traffy-archive.json', { results: [] });
  for (const r of [...(tf.results || []), ...(tfa.results || [])]) {
    const la = +r.coords[1], lo = +r.coords[0], t = utcTime(r.timestamp);
    if (!inBkk(la, lo) || isNaN(t)) continue;
    history.push({ la, lo, t });
    if (r.state !== 'เสร็จสิ้น') reports.push({ la, lo, t, src: 'traffy' });
  }
  src.traffy = (tf.results || []).length + (tfa.results || []).length;
  // iTIC / Longdo
  try {
    const ev = JSON.parse(await fetchText('https://event.longdo.com/feed/json', {}, 45000));
    for (const e of ev) {
      if (!(String(e.type) === '6' || e.icon === 'flood')) continue;
      const la = +e.latitude, lo = +e.longitude, t = bkkTime(e.start), stop = bkkTime(e.stop);
      if (inBkk(la, lo) && !isNaN(t) && (isNaN(stop) || stop >= now.getTime())) reports.push({ la, lo, t, src: 'itic' });
    }
    src.itic = true;
  } catch (e) { src.itic = 'error: ' + e.message; }
  // หมุดประชาชน
  try {
    const ep = JSON.parse(await readFile(path.join(DATA, 'report-config.json'), 'utf8')).endpoint;
    if (ep) {
      const d = JSON.parse(await fetchText(ep + '?action=list', {}, 30000));
      for (const r of d.reports || []) if (r.status === 'open') reports.push({ la: r.lat, lo: r.lng, t: Date.parse(r.created_at), src: 'web', lv: WEB_LV[r.level] || 2 });
      src.web = true;
    }
  } catch (e) { src.web = 'error: ' + e.message; }
  // ข่าวที่ระบุตำแหน่งได้และรายงานว่ามีน้ำท่วม
  const news = await readJSON('news.json', { items: [] });
  for (const n of news.items || []) {
    if (n.severity !== 'สูง' && n.severity !== 'กลาง') continue;
    for (const p of n.pins || []) if (p.precision === 'place') reports.push({ la: p.lat, lo: p.lng, t: Date.parse(n.published), src: 'news' });
  }
  // ThaiWater ฝน + ระดับน้ำ (กทม. และจังหวัดรอบ ๆ ช่วยประมาณฝนบริเวณขอบเมือง)
  // ใช้ทุกสถานีในกรอบรอบ กทม. (รวมนนทบุรี ปทุมธานี สมุทรปราการ นครปฐม สมุทรสาคร ที่อยู่ติดขอบเมือง)
  const nearBkk = (la, lo) => la >= 13.35 && la <= 14.1 && lo >= 100.2 && lo <= 101.05;
  const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
  // จังหวัดที่หน้าเว็บใช้ (กทม. + ลุ่มเจ้าพระยา) — เก็บสำเนาย่อไว้ให้หน้าเว็บโหลดเร็วแทนไฟล์เต็มหลาย MB
  const WEB_PROV = new Set(['10', '11', '12', '13', '14', '15', '16', '17', '18', '60', '61', '72']);
  const keepWeb = (x) => (x.geocode && WEB_PROV.has(String(x.geocode.province_code))) || (x.station && nearBkk(+x.station.tele_station_lat, +x.station.tele_station_long));
  try {
    const d = JSON.parse(await fetchText(TW + 'rain_24h', { headers: { Referer: 'https://www.thaiwater.net/' } }, 90000));
    await writeJSON('tw-rain.json', { updated: now.toISOString(), data: (d.data || []).filter(keepWeb) });
    for (const x of d.data || []) {
      if (!x.station || !nearBkk(+x.station.tele_station_lat, +x.station.tele_station_long)) continue;
      const t = bkkTime(x.rainfall_datetime);
      if (isNaN(t) || now - t > 6 * 36e5) continue;
      rain.push({ la: +x.station.tele_station_lat, lo: +x.station.tele_station_long, mm1: +x.rain_1h || 0, mm24: +x.rain_24h || 0 });
    }
    src.rain = rain.length;
  } catch (e) { src.rain = 'error: ' + e.message; }
  try {
    const d = JSON.parse(await fetchText(TW + 'waterlevel_load', { headers: { Referer: 'https://www.thaiwater.net/' } }, 90000));
    await writeJSON('tw-wl.json', { updated: now.toISOString(), waterlevel_data: { data: ((d.waterlevel_data && d.waterlevel_data.data) || []).filter(keepWeb) } });
    for (const x of (d.waterlevel_data && d.waterlevel_data.data) || []) {
      if (!x.station || !nearBkk(+x.station.tele_station_lat, +x.station.tele_station_long)) continue;
      const t = bkkTime(x.waterlevel_datetime);
      if (isNaN(t) || now - t > 6 * 36e5 || x.storage_percent == null) continue;
      wl.push({ la: +x.station.tele_station_lat, lo: +x.station.tele_station_long, pct: +x.storage_percent, name: (x.station.tele_station_name && x.station.tele_station_name.th) || '' });
    }
    src.wl = wl.length;
  } catch (e) { src.wl = 'error: ' + e.message; }

  // ฝนพยากรณ์ 3 ชม. ข้างหน้ารายจุดจากกรมอุตุฯ (ไฟล์ที่ updateTmdForecast เพิ่งเขียนรอบนี้)
  const tmd = await readJSON('tmd-forecast.json', { areas: [] });
  if (now - Date.parse(tmd.updated || 0) <= 6 * 36e5) {
    for (const a of tmd.areas || []) {
      if (!a.la || !a.lo) continue;
      const mm = a.hours.filter((h) => { const t = Date.parse(h.t); return t > now - 30 * 6e4 && t <= now.getTime() + 3 * 36e5; }).reduce((x, h) => x + (h.rain || 0), 0);
      fc.push({ la: a.la, lo: a.lo, mm });
    }
  }
  src.fcst = fc.length;

  if (!roads) { meta.sources.risk = { ok: false, error: 'roads unavailable' }; return; }
  const state = newEvalState(await readJSON('risk-history.json', null));
  // ประวัติน้ำท่วมจากเซ็นเซอร์ถนน 1 ปี: จุดที่เซ็นเซอร์วัดน้ำท่วมบ่อย = ท่วมซ้ำบ่อย (H) เสริมประวัติ Traffy
  const evPts = await updateSensorEvents(state, twStations).catch((e) => { log('sensor events failed:', e.message); return []; });
  src.sensorEvents = evPts.length;
  const segs = scoreRoads(roads, { reports, history: [...history, ...evPts], rain, wl, fc }, now.getTime());
  const counts = { 3: 0, 2: 0 };
  segs.forEach((s) => counts[s.tier]++);
  // เก็บผลรอบนี้ไว้วัดความแม่นภายหลัง + ตัวเทียบ "จุดท่วมบ่อย" จำนวนเท่ากับระดับควรระวังมาก
  state.runs.push({ t: now.getTime(), rb: roads.built, rain: Math.round(Math.max(0, ...rain.map((r) => r.mm1 || 0))),
    segs: segs.map((s) => [s.id, s.tier, s.drv]), base: segs.hot.slice(0, counts[3]) });
  // รายงานจริงสำหรับตรวจ: Traffy ทุกเรื่อง (ครั้งเดียว) + iTIC + หมุดประชาชน + เซ็นเซอร์ (ไม่รวมข่าว ตำแหน่งไม่แม่น)
  const evalReports = [...history.map((h) => ({ ...h, src: 'traffy' })), ...reports.filter((r) => r.src !== 'news' && r.src !== 'traffy')];
  const accuracy = evalUpdate(state, roads, evalReports, now.getTime());
  await writeJSON('risk-history.json', state);
  const soi = roads.segments.filter((s) => !isMain(s.cls)).length;
  await writeJSON('risk-roads.json', { updated: now.toISOString(), roadSegments: roads.segments.length, soiSegments: soi, sources: src, counts, accuracy, ...packSegments(segs.slice(0, 5000)) });
  meta.sources.risk = { ok: true, segments: segs.length, counts, sources: src };
}

// ---------- น้ำขึ้นน้ำลงปากแม่น้ำเจ้าพระยา (ตารางพยากรณ์ของกองทัพเรือ ผ่าน สสน.) ----------
async function updateTide(meta) {
  try {
    const txt = await fetchText('https://fews2.hii.or.th/model-output/data_portal/tide_table/summary.txt', {}, 30000);
    const [head, ...lines] = txt.trim().split(/\r?\n/);
    const keys = head.split(',');
    const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [keys[i], v])));
    const WANT = ['N01', 'N02', 'N03', 'N04']; // กองบัญชาการทัพเรือ, ท่าเรือกรุงเทพ, ป้อมพระจุล, สันดอนเจ้าพระยา
    const stations = rows.filter((r) => WANT.includes(r.code)).map((r) => ({
      code: r.code, name: r['station.name.TH'], date: r.date, max: +r.max_value, maxAt: r.max_time, min: +r.min_value, minAt: r.min_time,
      h4: ['0000', '0400', '0800', '1200', '1600', '2000'].map((h) => +r['time_' + h]),
    }));
    if (!stations.length) throw new Error('no Chao Phraya stations');
    await writeJSON('tide.json', { updated: now.toISOString(), source: 'กองทัพเรือ / สสน.', stations });
    meta.sources.tide = { ok: true, stations: stations.length, date: stations[0].date };
  } catch (e) { log('tide failed:', e.message); meta.sources.tide = { ok: false, error: e.message }; }
}

// ---------- ประวัติน้ำท่วมจากเซ็นเซอร์ถนน กทม. (ThaiWater flood_road_graph ทุก 10 นาที) ----------
// เก็บเป็นช่วงน้ำท่วม (≥5 ซม.) ไว้ใน state.ev ของ risk-history.json (ไฟล์ที่ cache อยู่แล้ว)
// ครั้งแรกดึงย้อนหลัง 1 ปีทีละ 8 สถานีต่อรอบ (ครบใน ~8 ชม.) จากนั้นทยอยดึง 3 วันล่าสุดวนไปทีละ 8 สถานี
const EV_DAYS = 365, EV_PER_RUN = 8;
async function updateSensorEvents(state, stations) {
  const ev = (state.ev ||= { st: {}, list: [] });
  if (stations.length) {
    const fetched = (x) => ev.st[x.id] || 0;
    const todo = stations.filter((x) => !fetched(x)).slice(0, EV_PER_RUN);
    const refresh = todo.length ? [] : [...stations].sort((a, b) => fetched(a) - fetched(b)).filter((x) => now - fetched(x) > 6 * 36e5).slice(0, EV_PER_RUN);
    const day = (ms) => new Date(ms + 7 * 36e5).toISOString().slice(0, 10);
    for (const [x, days] of [...todo.map((x) => [x, EV_DAYS]), ...refresh.map((x) => [x, 3])]) {
      try {
        const from = now - days * 864e5;
        const j = JSON.parse(await fetchText(`https://api-v3.thaiwater.net/api/v1/thaiwater30/public/flood_road_graph?station_id=${x.id}&date_start=${day(from)}&date_end=${day(now.getTime())}`,
          { headers: { Referer: 'https://www.thaiwater.net/' } }, 60000));
        const pts = (j.data || []).map((p) => [bkkTime(p.floodroad_datetime), p.floodroad_value == null ? null : +p.floodroad_value]).filter((p) => !isNaN(p[0])).sort((a, b) => a[0] - b[0]);
        // ช่วงน้ำท่วม: ค่า ≥ 5 ซม. ต่อเนื่อง (ขาดข้อมูลไม่เกิน 1 ชม.) อย่างน้อย 2 จุด (20 นาที)
        const eps = []; let cur = null;
        for (const [t, v] of pts) {
          if (v != null && v >= 5) {
            if (cur && t - cur.e <= 36e5) { cur.e = t; cur.max = Math.max(cur.max, v); cur.n++; }
            else { if (cur) eps.push(cur); cur = { s: t, e: t, max: v, n: 1 }; }
          }
        }
        if (cur) eps.push(cur);
        ev.list = ev.list.filter(([id, s]) => !(id === x.id && s >= from)).concat(eps.filter((e) => e.n >= 2).map((e) => [x.id, e.s, e.e, Math.round(e.max)]));
        ev.st[x.id] = now.getTime();
      } catch (e) { log(`sensor history ${x.c} failed:`, e.message); }
    }
    ev.list = ev.list.filter(([, s]) => now - s <= EV_DAYS * 864e5);
  }
  const pos = new Map(stations.map((x) => [x.id, x]));
  meta.sources.sensorHistory = { stations: Object.keys(ev.st).length, of: stations.length, events: ev.list.length };
  // จุดประวัติสำหรับ H (ตัดช่วงที่เพิ่งเกิดใน 6 ชม. ออกเองใน scoreRoads)
  return ev.list.filter(([id]) => pos.has(id)).map(([id, s]) => ({ la: pos.get(id).la, lo: pos.get(id).lo, t: s }));
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
await updateTraffy(meta);
await updateCamsRadar(meta);
await updateThaiwater(meta);
await updateTide(meta);
await updateTmdForecast(meta).catch((e) => { log('tmd forecast failed:', e.message); meta.sources.tmdFcst = { ok: false, error: e.message }; });
await updateRisk(meta).catch((e) => { log('risk failed:', e); meta.sources.risk = { ok: false, error: e.message }; });
await writeJSON('meta.json', meta);
log('done', JSON.stringify(meta));
