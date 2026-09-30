// yt-drive - search YouTube and send a video/audio to Google Drive, from any device.
// The Worker holds the secrets and does the SEARCH (YouTube Data API). The DOWNLOAD runs in GitHub Actions (yt-dlp).
//   POST /api/login / GET /api/me / POST /api/logout   - password gate (HMAC cookie)
//   GET  /api/search?q=...                              - YouTube Data API search.list (+ durations)
//   GET  /api/kan/search, /api/c13/search, /api/library?source=kan|c13, /api/episodes?url= - Kan / Reshet 13
//        series search and whole-library browsing (daily indexes in data/), episode lists
//   POST /api/jobs   {input, options:{format}}          - dispatch yt-drive.yml with the video URL
//   GET  /api/jobs / GET /api/jobs/:id                  - recent jobs + one job's status/result
//   GET  /api/files/:assetId                            - download a result file (when Drive is off)
//   POST /share                                         - PWA share target
// Worker secrets: APP_PASSWORD, GH_TOKEN (fine-grained: Actions RW + Contents RW on GH_REPO), YT_API_KEY.
// Vars: GH_REPO, GH_REF, WORKFLOW="yt-drive.yml".

const TITLE = /^yt \[([0-9a-f]{6,16})\]: (.*)$/;
const COOKIE = 'ytd';
const MONTH = 60 * 60 * 24 * 30;
const YT_URL = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?|shorts\/|live\/|playlist\?)|youtu\.be\/)/i;
const KAN_URL = /^(https?:\/\/)?(www\.)?kan\.org\.il\//i;
const KAN_SERIES = /^https:\/\/www\.kan\.org\.il\/content\/kan\/[^/]+\/p-\d+\/$/;          // a whole series
const KAN_SEASON = /^https:\/\/www\.kan\.org\.il\/content\/kan\/[^/]+\/p-\d+\/s\d+\/$/;   // one season of it
const KAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const C13_URL = /^(https?:\/\/)?(www\.)?13tv\.co\.il\//i;

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (p === '/share' && request.method === 'POST') return Response.redirect(new URL('/?share=nosw', url), 303);
  if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!env.APP_PASSWORD || !env.GH_TOKEN) return json({ error: 'השרת עוד לא הוגדר (APP_PASSWORD / GH_TOKEN חסרים)' }, 500);

  if (p === '/api/login' && request.method === 'POST') return login(request, env);
  if (!(await authed(request, env))) return json({ error: 'צריך להתחבר' }, 401);

  if (p === '/api/me') return json({ ok: true, search: !!env.YT_API_KEY });
  if (p === '/api/logout' && request.method === 'POST')
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  if (p === '/api/search' && request.method === 'GET') return search(env, url.searchParams.get('q') || '', url.searchParams.get('type'));
  if (p === '/api/info' && request.method === 'GET') return linkInfo(env, url.searchParams.get('url') || '');
  if (p === '/api/kan/search' && request.method === 'GET') return indexSearch(env, 'kan', url.searchParams.get('q') || '');
  if (p === '/api/library' && request.method === 'GET') return library(env, url.searchParams.get('source') || '');
  if (p === '/api/c13/search' && request.method === 'GET') return indexSearch(env, 'c13', url.searchParams.get('q') || '');
  if ((p === '/api/episodes' || p === '/api/kan/episodes') && request.method === 'GET') {
    const u = url.searchParams.get('url') || '';
    return C13_URL.test(u) ? c13Episodes(u) : kanEpisodes(u);
  }
  if (p === '/api/jobs' && request.method === 'POST') return startJob(request, env);
  if (p === '/api/jobs' && request.method === 'GET') return listJobs(env);
  let m = p.match(/^\/api\/jobs\/([0-9a-f]{6,16})$/);
  if (m && request.method === 'GET') return jobStatus(env, m[1]);
  m = p.match(/^\/api\/files\/(\d+)$/);
  if (m && request.method === 'GET') return fileRedirect(env, m[1]);
  return json({ error: 'not found' }, 404);
}

function json(o, s = 200, h = {}) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h } });
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function sessionToken(env) { return hmac(env.APP_PASSWORD, 'yt-drive-session-v1'); }
async function authed(request, env) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return !!m && safeEqual(m[1], await sessionToken(env));
}
async function login(request, env) {
  const b = await request.json().catch(() => ({}));
  const given = await hmac('cmp', String(b.password || '')), want = await hmac('cmp', env.APP_PASSWORD);
  if (!safeEqual(given, want)) { await new Promise(r => setTimeout(r, 1200)); return json({ error: 'סיסמה שגויה' }, 401); }
  const t = await sessionToken(env);
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${t}; Path=/; Max-Age=${MONTH}; HttpOnly; Secure; SameSite=Strict` });
}

// ---- YouTube search (Data API v3): search.list for hits, then videos.list for durations ----
function iso8601ToClock(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || [];
  const days = +(m[1] || 0), h = +(m[2] || 0) + days * 24, mi = +(m[3] || 0), s = +(m[4] || 0);
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(mi)}:${p(s)}` : `${mi}:${p(s)}`;
}
async function ytApi(env, path) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '&key=' + env.YT_API_KEY,
    { headers: { 'Accept': 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = d.error && d.error.errors && d.error.errors[0] && d.error.errors[0].reason;
    if (reason === 'quotaExceeded') throw new Error('מכסת החיפוש היומית של YouTube נגמרה (מתאפסת בחצות שעון האוקיינוס השקט)');
    if (r.status === 400 || reason === 'keyInvalid') throw new Error('מפתח ה-YouTube (YT_API_KEY) לא תקין או שה-API לא מופעל בפרויקט');
    throw new Error(`YouTube API ${r.status}: ${(d.error && d.error.message || '').slice(0, 140)}`);
  }
  return d;
}
async function search(env, q, type) {
  q = q.trim();
  if (!q) return json({ items: [] });
  if (!env.YT_API_KEY) return json({ error: 'חיפוש כבוי - הגדר YT_API_KEY ב-Worker כדי לחפש (אפשר גם פשוט להדביק קישור)' }, 400);
  if (type === 'playlist') return searchPlaylists(env, q);
  const s = await ytApi(env, `search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q)}`);
  const ids = (s.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
  const durs = {};
  if (ids.length) {
    const v = await ytApi(env, `videos?part=contentDetails&id=${ids.join(',')}`);
    for (const it of v.items || []) durs[it.id] = iso8601ToClock(it.contentDetails && it.contentDetails.duration);
  }
  const items = (s.items || []).filter(i => i.id && i.id.videoId).map(i => {
    const sn = i.snippet || {}, th = sn.thumbnails || {};
    return {
      id: i.id.videoId,
      url: 'https://www.youtube.com/watch?v=' + i.id.videoId,
      title: sn.title || '',
      channel: sn.channelTitle || '',
      thumb: (th.medium || th.high || th.default || {}).url || '',
      duration: durs[i.id.videoId] || '',
      published: sn.publishedAt || '',
      kind: 'video',
    };
  });
  return json({ items });
}
// ---- Kan (kan.org.il): search over the daily series index, and episode lists parsed from the site's own pages ----
// Kan's site search is a third-party widget with no usable API, so data/kan-index.json (built daily by the kan-index
// workflow from the VOD lobby pages) is searched here. Episode lists come from the series / season pages (plain HTML).
const decodeHtml = s => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
// Hebrew-friendly matching: no niqqud, no punctuation, lower-case Latin
const normHe = s => String(s || '').normalize('NFKD').replace(/[֑-ׇ]/g, '').toLowerCase()
  .replace(/["'׳״`.,:;!?()\-–_/\\]/g, ' ').replace(/\s+/g, ' ').trim();
function normKanUrl(raw) {        // https, no query/hash, trailing slash (the shape KAN_SERIES / KAN_SEASON expect)
  try {
    const x = new URL(/^https?:/i.test(raw) ? raw : 'https://' + raw);
    x.hash = ''; x.search = ''; if (!x.pathname.endsWith('/')) x.pathname += '/';
    return x.href;
  } catch { return raw; }
}
// The daily catalogue indexes (data/*.json, built by the kan-index workflow), cached per isolate for 30 minutes.
// Kan: section s (kan-11 / kan-actual ...). 13: genres g, catalogue date d, full-episode count n.
const KAN_SECTIONS = { 'kan-11': 'כאן 11', 'kan-actual': 'אקטואליה' };
const indexes = {};
async function loadIndex(env, source) {
  const c = indexes[source];
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.items;
  const file = source === 'c13' ? 'c13-index.json' : 'kan-index.json';
  const r = await fetch(`https://raw.githubusercontent.com/${env.GH_REPO}/${env.GH_REF}/data/${file}`,
    { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw new Error('אינדקס הסדרות עוד לא נוצר (הוא מתעדכן פעם ביום)');
  const d = await r.json();
  const items = (d.items || []).map(x => source === 'c13'
    ? { title: x.t, url: x.u, thumb: x.i, groups: x.g || [], count: x.n || 0, n: normHe(x.t) }
    : { title: x.t, url: x.u, thumb: x.i, groups: [KAN_SECTIONS[x.s] || 'עוד'], n: normHe(x.t) });
  indexes[source] = { at: Date.now(), items, updated: d.updated || '' };
  return items;
}
// all words must match; starts with the first word, then a word that starts with it, then anywhere; shorter first
async function indexSearch(env, source, q) {
  const words = normHe(q).split(' ').filter(Boolean);
  if (!words.length) return json({ items: [] });
  const hits = [];
  for (const it of await loadIndex(env, source)) {
    if (!words.every(w => it.n.includes(w))) continue;
    const rank = it.n.startsWith(words[0]) ? 0 : it.n.includes(' ' + words[0]) ? 1 : 2;
    hits.push({ it, score: rank * 1000 + it.title.length });
  }
  hits.sort((a, b) => a.score - b.score);
  return json({ items: hits.slice(0, 30).map(({ it }) => ({ url: it.url, title: it.title, channel: source === 'c13' ? '13' : 'כאן',
    thumb: it.thumb, kind: source === 'c13' ? 'series' : 'kan' })) });
}
// the whole library of one channel, for browsing: the page filters, groups and sorts it itself
async function library(env, source) {
  if (source !== 'kan' && source !== 'c13') return json({ error: 'מקור לא מוכר' }, 400);
  const items = await loadIndex(env, source);
  return json({ source, updated: indexes[source].updated,
    items: items.map(({ title, url, thumb, groups, count }) => ({ title, url, thumb, groups, count })) },
    200, { 'Cache-Control': 'private, max-age=600' });
}
async function kanPage(u) {
  const r = await fetch(u, { headers: { 'User-Agent': KAN_UA, 'Accept-Language': 'he-IL,he;q=0.9' } });
  if (!r.ok) throw new Error(`לא הצלחתי לקרוא את הדף של כאן (${r.status})`);
  return r.text();
}
// Kan's markup puts newlines and indentation between attributes, so every pattern below uses \s+ between them.
function kanProgram(h) {          // the program's real name, without the "- season N | full episodes" style suffixes
  // season pages carry an EMPTY npawData.program, so take the first candidate that is non-empty
  for (const re of [/npawData\.program\s*=\s*decodeEntities\('([^']*)'\)/, /<meta\s+property="og:title"\s+content="([^"]*)"/, /<title>\s*([^<]*)/]) {
    const m = h.match(re);
    const t = m ? decodeHtml(m[1]).replace(/\s*[-|]?\s*(פרקים מלאים.*|עונה \d+.*)$/, '').trim() : '';
    if (t) return t;
  }
  return '';
}
function kanEpisodesOf(h) {
  const out = [], seen = new Set();
  const re = /<a\s+href="(https:\/\/www\.kan\.org\.il\/content\/kan\/[^"]+\/p-\d+\/s\d+\/\d+\/)"\s+class="card card-row[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(h))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const inner = m[2];
    const img = (inner.match(/<img\s+src="([^"]+)"/) || [])[1] || '';
    out.push({
      url: m[1],
      title: decodeHtml((inner.match(/<h3 class="card-title">\s*([^<]*?)\s*<\/h3>/) || [])[1] || '').trim(),
      duration: ((inner.match(/<span class="duration">\s*([^<]+?)\s*<\/span>/) || [])[1] || '').trim(),
      thumb: img ? new URL(decodeHtml(img), 'https://www.kan.org.il').href : '',
    });
  }
  return out;
}
function kanSeasonsOf(h) {
  const seen = new Map();
  const re = /<a\s+class="dropdown-item"\s+href="(https:\/\/www\.kan\.org\.il\/content\/kan\/[^"]+\/p-\d+\/s(\d+)\/)"[^>]*>\s*([^<]*?)\s*</g;
  let m;
  while ((m = re.exec(h))) seen.set(m[1], { n: +m[2], label: decodeHtml(m[3]).trim() || `עונה ${m[2]}`, url: m[1] });
  return [...seen.values()].sort((a, b) => a.n - b.n);
}
// the episodes of a series (its first season, with the season list to switch) or of one season
async function kanEpisodes(raw) {
  const u = normKanUrl(String(raw).trim());
  if (!KAN_SERIES.test(u) && !KAN_SEASON.test(u)) return json({ error: 'זה לא קישור של סדרה או עונה בכאן' }, 400);
  let page = await kanPage(u);
  const title = kanProgram(page);
  const seasons = kanSeasonsOf(page);
  let season = KAN_SEASON.test(u) ? u : '';
  if (!season) {
    if (seasons.length) { season = seasons[0].url; page = await kanPage(season); }
    else if (!kanEpisodesOf(page).length) { season = u + 's1/'; page = await kanPage(season); }
  }
  return json({ url: u, title, seasons, season, episodes: kanEpisodesOf(page).slice(0, 200), source: 'kan' });
}

// ---- Reshet 13 (13tv.co.il): its catalogue is a Kaltura OTT back end (partner 5031) that answers an anonymous
// session - the same one the site opens for every visitor - while 13tv.co.il itself sits behind a bot wall. Series are
// assets of type 1259, episodes type 1268 with metas SeriesID / SeasonNumber / EpisodeNumber; each episode carries the
// Kaltura entryId that the workflow downloads (HLS, up to 720p). URLs we use (the site's own shape):
//   series  https://13tv.co.il/allshows/series/<sid>/      season  .../series/<sid>/season/<n>/
//   episode .../series/<sid>/season/<n>/<assetId>/          single clip / movie  https://13tv.co.il/allshows/<assetId>/
const C13_OTT = 'https://5031.frp1.ott.kaltura.com/api_v3/service/';
const C13_SERIES = 1259, C13_EPISODE = 1268;
function parse13(raw) {
  try {
    const x = new URL(/^https?:/i.test(raw) ? raw : 'https://' + raw);
    const m = x.pathname.match(/\/series\/(\d+)(?:\/season\/(\d+)(?:\/(\d+))?)?\/?$/);
    if (m) return { sid: m[1], season: m[2] || '', asset: m[3] || '' };
    const a = x.pathname.match(/^\/allshows\/(\d+)\/?$/);
    if (a) return { sid: '', season: '', asset: a[1] };
  } catch {}
  return null;
}
const c13Url = ({ sid, season, asset }) => (!sid || (asset && !season)) ? `https://13tv.co.il/allshows/${asset}/`
  : `https://13tv.co.il/allshows/series/${sid}/` + (season ? `season/${season}/` : '') + (season && asset ? `${asset}/` : '');
let c13ks = '', c13ksExp = 0;
async function ottCall(svc, body) {
  const r = await fetch(C13_OTT + svc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, apiVersion: '5.4.0' }) });
  const d = await r.json().catch(() => ({}));
  const err = d.result && d.result.error;
  if (!r.ok || !d.result || err) throw new Error(`רשת 13 לא ענתה (${(err && err.message) || r.status})`);
  return d.result;
}
async function ott(svc, body) {
  if (!c13ks || Date.now() / 1000 > c13ksExp - 3600) {
    const s = await ottCall('ottuser/action/anonymousLogin', { partnerId: 5031 });
    c13ks = s.ks; c13ksExp = s.expiry || 0;
  }
  return ottCall(svc, { ...body, ks: c13ks });
}
async function ottList(kSql, { n = 100, order, props = 'id,name,metas,images' } = {}) {
  const filter = { objectType: 'KalturaSearchAssetFilter', kSql };
  if (order) filter.dynamicOrderBy = { objectType: 'KalturaDynamicOrderBy', name: order[0], orderBy: order[1] };
  const r = await ott('asset/action/list', { filter, pager: { pageSize: n, pageIndex: 1 },
    responseProfile: { objectType: 'KalturaOnDemandResponseProfile', retrievedProperties: props } });
  return { total: r.totalCount || 0, items: r.objects || [] };
}
const ottMeta = (o, k) => { const v = (o.metas || {})[k]; return v && v.value != null ? v.value : ''; };
function ottImage(o, ratio, w, h) {
  const im = (o.images || []).find(i => i.ratio === ratio) || (o.images || [])[0];
  return im && im.url ? `${im.url}/width/${w}/height/${h}` : '';
}
const secsClock = n => { n = Math.round(+n || 0); return n > 0 ? iso8601ToClock(`PT${Math.floor(n / 3600)}H${Math.floor(n / 60) % 60}M${n % 60}S`) : ''; };
const kq = s => String(s).replace(/['\\]/g, ' ').trim();      // a value inside KSQL quotes
async function c13SeriesAsset(sid) {
  const { items } = await ottList(`(and SeriesID='${kq(sid)}' asset_type='${C13_SERIES}')`, { n: 1, props: 'id,name,images' });
  return items[0] || null;
}
// the season numbers of a series, from its lowest and highest SeasonNumber (two one-item queries instead of a full scan)
async function c13Seasons(sid) {
  const q = `(and SeriesID='${kq(sid)}' asset_type='${C13_EPISODE}')`;
  const [lo, hi] = await Promise.all(['META_ASC', 'META_DESC'].map(o => ottList(q, { n: 1, order: ['SeasonNumber', o], props: 'metas' })));
  const a = +ottMeta(lo.items[0] || {}, 'SeasonNumber'), b = +ottMeta(hi.items[0] || {}, 'SeasonNumber');
  if (!a || !b) return [];
  const out = [];
  for (let n = Math.max(a, b - 39); n <= b; n++) out.push(n);
  return out;
}
// one season's episodes in order; a long-running show (news: hundreds in one season) gives its latest 100 instead.
// The workflow's c13_list.py orders exactly the same way, so "whole season" downloads what this list shows.
async function c13SeasonEpisodes(sid, season) {
  const q = `(and SeriesID='${kq(sid)}' asset_type='${C13_EPISODE}'` + (season ? ` SeasonNumber='${kq(season)}'` : '') + ')';
  const props = 'id,name,metas,images,mediaFiles';
  let r = await ottList(q, { n: 100, order: ['EpisodeNumber', 'META_ASC'], props });
  let latest = false;
  if (r.total > 100) { r = await ottList(q, { n: 100, order: ['EpisodeNumber', 'META_DESC'], props }); latest = true; }
  return { total: r.total, latest, items: r.items };
}
async function c13Episodes(raw) {
  const p = parse13(String(raw).trim());
  if (!p || !p.sid) return json({ error: 'זה לא קישור של סדרה או עונה ב-13' }, 400);
  const [series, seasons] = await Promise.all([c13SeriesAsset(p.sid), c13Seasons(p.sid)]);
  const title = series ? series.name : '';
  const season = p.season || (seasons.length ? String(seasons[seasons.length - 1]) : '');   // default: the newest season
  const eps = await c13SeasonEpisodes(p.sid, season);
  const strip = new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,:\\-]\\s*');
  return json({
    url: c13Url({ sid: p.sid }), title, source: '13', total: eps.total, latest: eps.latest,
    seasons: seasons.map(n => ({ n, label: `עונה ${n}`, url: c13Url({ sid: p.sid, season: String(n) }) })),
    season: season ? c13Url({ sid: p.sid, season }) : c13Url({ sid: p.sid }),
    episodes: eps.items.map(o => ({
      url: c13Url({ sid: p.sid, season: ottMeta(o, 'SeasonNumber') || season, asset: o.id }),
      title: title && strip.test(o.name || '') ? (o.name || '').replace(strip, '') : (o.name || ''),
      duration: secsClock(((o.mediaFiles || [])[0] || {}).duration),
      thumb: ottImage(o, '16x9', 320, 180),
    })),
  });
}
async function c13Info(raw) {
  const p = parse13(raw);
  if (!p) return json({ error: 'לא הצלחתי לזהות את הקישור של 13. צריך קישור של פרק, עונה או סדרה.' }, 400);
  if (p.asset) {
    const o = await ott('asset/action/get', { id: p.asset, assetReferenceType: 'media' });
    return json({ url: c13Url(p), title: o.name || '', channel: '13', thumb: ottImage(o, '16x9', 480, 270), playlist: false, source: '13', listKind: '' });
  }
  const s = await c13SeriesAsset(p.sid);
  if (!s) return json({ error: 'הסדרה לא נמצאה ב-13' }, 404);
  const kind = p.season ? 'season' : 'series';
  return json({ url: c13Url(p), title: s.name + (p.season ? ` · עונה ${p.season}` : ''), channel: '13', thumb: ottImage(s, '2x3', 240, 360),
    playlist: true, source: '13', listKind: kind });
}

// A playlist's title / channel / thumbnail / item count from the YouTube Data API (1 quota unit). Null when there
// is no key, no such list (auto-generated mixes such as list=RD... are not in the API), or the quota is spent.
async function playlistMeta(env, listId) {
  if (!env.YT_API_KEY || !listId) return null;
  try {
    const d = await ytApi(env, `playlists?part=snippet,contentDetails&id=${encodeURIComponent(listId)}`);
    const it = (d.items || [])[0];
    if (!it) return null;
    const sn = it.snippet || {}, th = sn.thumbnails || {};
    return { title: sn.title || '', channel: sn.channelTitle || '',
      thumb: (th.medium || th.high || th.default || {}).url || '', count: it.contentDetails && it.contentDetails.itemCount };
  } catch { return null; }
}
const listIdOf = u => ((String(u).match(/[?&]list=([A-Za-z0-9_-]+)/) || [])[1]) || '';

// title + channel + thumbnail for a pasted link. YouTube -> public oEmbed (+ playlist details from the Data API);
// Kan -> the page's Open Graph tags.
async function linkInfo(env, raw) {
  const m = String(raw).match(/https?:\/\/\S+/i);
  const u = m ? m[0] : String(raw).trim();
  if (C13_URL.test(u)) return c13Info(u);
  if (KAN_URL.test(u)) {
    const ku = normKanUrl(u);
    const kind = KAN_SEASON.test(ku) ? 'season' : KAN_SERIES.test(ku) ? 'series' : 'episode';
    const h = await kanPage(ku);
    const og = p => decodeHtml((h.match(new RegExp('<meta\\s+property="og:' + p + '"\\s+content="([^"]*)"', 'i')) || [])[1] || '');
    // a series / season page is described by the program's name, an episode page by its own title
    const title = kind === 'episode' ? (og('title') || decodeHtml((h.match(/<title>([^<]*)/i) || [])[1] || '')) : kanProgram(h);
    return json({ url: ku, title: title.trim(), channel: 'כאן 11', thumb: og('image'), playlist: kind !== 'episode', kan: true, kanKind: kind, source: 'kan', listKind: kind === 'episode' ? '' : kind });
  }
  if (!YT_URL.test(u)) return json({ error: 'לא קישור של יוטיוב, כאן או 13' }, 400);
  const listId = listIdOf(u);
  const pureList = /youtube\.com\/playlist\?/i.test(u);
  const pm = listId ? await playlistMeta(env, listId) : null;
  if (pureList && pm) {                       // a playlist link: describe the list itself
    return json({ url: u, title: pm.title, channel: pm.channel, thumb: pm.thumb, playlist: true, count: pm.count ?? null });
  }
  const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u));
  if (!r.ok) return json({ error: pureList ? 'הפלייליסט לא נמצא או פרטי' : (r.status === 404 ? 'הסרטון לא נמצא או פרטי' : 'לא הצלחתי לקרוא את פרטי הקישור') }, 404);
  const d = await r.json();
  // a video link that also carries a list (watch?v=..&list=..): describe the video, and add the list's size and
  // title so the page can offer "download the whole playlist"
  return json({ url: u, title: d.title || '', channel: d.author_name || '', thumb: d.thumbnail_url || '',
    playlist: pureList || !!listId, listCount: pm ? (pm.count ?? null) : null, listTitle: pm ? pm.title : '' });
}
async function searchPlaylists(env, q) {
  const s = await ytApi(env, `search?part=snippet&type=playlist&maxResults=12&q=${encodeURIComponent(q)}`);
  const ids = (s.items || []).map(i => i.id && i.id.playlistId).filter(Boolean);
  const counts = {};
  if (ids.length) {
    const p = await ytApi(env, `playlists?part=contentDetails&id=${ids.join(',')}`);
    for (const it of p.items || []) counts[it.id] = it.contentDetails && it.contentDetails.itemCount;
  }
  const items = (s.items || []).filter(i => i.id && i.id.playlistId).map(i => {
    const sn = i.snippet || {}, th = sn.thumbnails || {};
    const n = counts[i.id.playlistId];
    return {
      id: i.id.playlistId,
      url: 'https://www.youtube.com/playlist?list=' + i.id.playlistId,
      title: sn.title || '',
      channel: sn.channelTitle || '',
      thumb: (th.medium || th.high || th.default || {}).url || '',
      duration: n != null ? `${n} פריטים` : 'פלייליסט',
      count: n,
      kind: 'playlist',
    };
  });
  return json({ items });
}

async function gh(env, path, init = {}) {
  const base = path.startsWith('https://') ? '' : 'https://api.github.com';
  return fetch(base + path, { ...init, headers: {
    Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'yt-drive', ...(init.headers || {}) } });
}
async function ghJson(env, path, init) {
  const r = await gh(env, path, init);
  if (r.status === 401) throw new Error('הטוקן של GitHub (GH_TOKEN) לא תקין או שפג תוקפו');
  if (r.status === 403 || (r.status === 404 && path.includes('/actions/')))
    throw new Error(`ל-GitHub אין הרשאה או שה-workflow לא נמצא (${r.status}) - בדוק Actions/Contents בטוקן ושה-workflow נדחף`);
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.status === 204 ? null : r.json();
}
function newId() { const b = crypto.getRandomValues(new Uint8Array(5)); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

async function startJob(request, env) {
  const b = await request.json().catch(() => ({}));
  let input = String(b.input || '').trim();
  const m = input.match(/https?:\/\/\S+/i);
  if (m) input = m[0];
  if (KAN_URL.test(input)) input = normKanUrl(input);     // the workflow tells episode / season / series apart by the URL
  let c13 = null;
  if (C13_URL.test(input)) {                               // 13: our canonical URL shape, which c13_list.py in the workflow reads
    c13 = parse13(input);
    if (!c13) return json({ error: 'לא הצלחתי לזהות את הקישור של 13. צריך קישור של פרק, עונה או סדרה.' }, 400);
    input = c13Url(c13);
  }
  if (!YT_URL.test(input) && !KAN_URL.test(input) && !c13) return json({ error: 'צריך קישור של יוטיוב, כאן או 13 (או לבחור מתוצאות החיפוש)' }, 400);
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  const o = b.options || {};
  const format = o.format === 'audio' ? 'audio' : 'video';
  const quality = ['best', '1080', '720', '480'].includes(String(o.quality)) ? String(o.quality) : '1080';
  // a pure playlist link always means the whole list; a watch?v=..&list=.. link only when asked
  const playlist = (o.playlist === 'yes' || /youtube\.com\/playlist\?/i.test(input) || KAN_SERIES.test(input) || KAN_SEASON.test(input) || (c13 && !c13.asset)) ? 'yes' : 'no';
  // how many playlist items from the start: 1..100, default 50 (Kan / single videos ignore it)
  const maxItems = String(Math.min(100, Math.max(1, parseInt(o.max_items, 10) || 50)));
  const id = newId();
  await ghJson(env, `/repos/${env.GH_REPO}/actions/workflows/${env.WORKFLOW}/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: env.GH_REF, inputs: { input, format, quality, playlist, max_items: maxItems, job_id: id } }) });
  return json({ id, input, format, quality, playlist, max_items: maxItems, created_at: new Date().toISOString() });
}
async function recentRuns(env, n = 40) {
  const d = await ghJson(env, `/repos/${env.GH_REPO}/actions/workflows/${env.WORKFLOW}/runs?per_page=${n}`);
  return d.workflow_runs || [];
}
function runSummary(run) {
  const m = (run.display_title || '').match(TITLE);
  return { id: m ? m[1] : null, input: m ? m[2] : run.display_title, status: run.status, conclusion: run.conclusion,
    created_at: run.created_at, run_url: run.html_url, run_id: run.id };
}
async function listJobs(env) { const runs = await recentRuns(env, 30); return json({ jobs: runs.map(runSummary).filter(j => j.id) }); }
async function jobStatus(env, id) {
  const runs = await recentRuns(env, 50);
  const run = runs.find(r => (r.display_title || '').startsWith(`yt [${id}]`));
  if (!run) return json({ id, status: 'pending' });
  const out = runSummary(run);
  if (run.status !== 'completed') {
    const jobs = await ghJson(env, `/repos/${env.GH_REPO}/actions/runs/${run.id}/jobs`);
    const steps = (jobs.jobs && jobs.jobs[0] && jobs.jobs[0].steps) || [];
    const cur = steps.find(s => s.status === 'in_progress') || steps.filter(s => s.status === 'completed').pop();
    out.step = cur ? cur.name : null; out.steps_done = steps.filter(s => s.status === 'completed').length; out.steps_total = steps.length;
    return json(out);
  }
  const r = await gh(env, `/repos/${env.GH_REPO}/releases/tags/job-${id}`);
  if (r.ok) { const rel = await r.json(); out.summary = rel.body || '';
    out.files = (rel.assets || []).map(a => ({ name: a.name, size: a.size, url: `/api/files/${a.id}` })); }
  else out.files = [];
  return json(out);
}
async function fileRedirect(env, assetId) {
  const r = await gh(env, `/repos/${env.GH_REPO}/releases/assets/${assetId}`, { headers: { Accept: 'application/octet-stream' }, redirect: 'manual' });
  const loc = r.headers.get('Location');
  if (loc) return Response.redirect(loc, 302);
  if (r.ok) return new Response(r.body, { headers: { 'Content-Type': 'application/octet-stream' } });
  return json({ error: `הקובץ לא נמצא (${r.status})` }, 404);
}
