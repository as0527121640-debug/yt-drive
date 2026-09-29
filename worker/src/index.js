// yt-drive - search YouTube and send a video/audio to Google Drive, from any device.
// The Worker holds the secrets and does the SEARCH (YouTube Data API). The DOWNLOAD runs in GitHub Actions (yt-dlp).
//   POST /api/login / GET /api/me / POST /api/logout   - password gate (HMAC cookie)
//   GET  /api/search?q=...                              - YouTube Data API search.list (+ durations)
//   POST /api/jobs   {input, options:{format}}          - dispatch yt-drive.yml with the video URL
//   GET  /api/jobs / GET /api/jobs/:id                  - recent jobs + one job's status/result
//   GET  /api/files/:assetId                            - download a result file (when Drive is off)
//   POST /share                                         - PWA share target
// Worker secrets: APP_PASSWORD, GH_TOKEN (fine-grained: Actions RW + Contents RW on GH_REPO), YT_API_KEY.
// Vars: GH_REPO, GH_REF, WORKFLOW="yt-drive.yml".

const TITLE = /^yt \[([0-9a-f]{6,16})\]: (.*)$/;
const COOKIE = 'ytd';
const MONTH = 60 * 60 * 24 * 30;
const YT_URL = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)/i;

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
  if (p === '/api/search' && request.method === 'GET') return search(env, url.searchParams.get('q') || '');
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
async function search(env, q) {
  q = q.trim();
  if (!q) return json({ items: [] });
  if (!env.YT_API_KEY) return json({ error: 'חיפוש כבוי - הגדר YT_API_KEY ב-Worker כדי לחפש (אפשר גם פשוט להדביק קישור)' }, 400);
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
  if (!YT_URL.test(input)) return json({ error: 'צריך קישור של YouTube (או לבחור מתוצאות החיפוש)' }, 400);
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  const format = (b.options && b.options.format) === 'audio' ? 'audio' : 'video';
  const id = newId();
  await ghJson(env, `/repos/${env.GH_REPO}/actions/workflows/${env.WORKFLOW}/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: env.GH_REF, inputs: { input, format, job_id: id } }) });
  return json({ id, input, format, created_at: new Date().toISOString() });
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
