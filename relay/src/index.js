// il-relay - a small, keyed fetch relay that Cloudflare runs in its Tel Aviv data center.
// Why: the user is in Israel and Kan (the Israeli public broadcaster) streams its content free to viewers in Israel,
// but the yt-drive downloader runs on GitHub's machines abroad, where Kan's CDN answers 403 by country. This relay
// fetches the same public HLS from an Israeli address - the same vantage point as the user's own device - and
// streams it back. It does NOT forge any site's headers: measured 2026-09-30, Kan's CDN gates purely on the client
// IP's country (a plain request from an Israeli IP returns 200), so a normal browser User-Agent is all it sends.
//
// Placement hint azure:israelcentral -> Cloudflare executes this in TLV and egresses from an IL-geolocated IP
// (measured; aws:il-central-1 landed in ZDM, gcp:me-west1 in Mumbai, so azure is the one that works).
//
//   GET /health                          -> { colo } (which data center this ran in)
//   GET /r/<name>?k=<RELAY_KEY>&u=<url>  -> streams the url's body. HLS playlists come back with every child URI
//                                           rewritten through the relay too, so a normal HLS client (yt-dlp/ffmpeg) works.
// Not an open proxy: a shared key (secret RELAY_KEY) and a host allowlist (Kan and its CDN only).

const ALLOW = [/(^|\.)kan\.org\.il$/i, /(^|\.)cdn-redge\.media$/i, /(^|\.)kaltura\.com$/i];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, colo: req.cf && req.cf.colo });
    if (!url.pathname.startsWith('/r/')) return new Response('not found', { status: 404 });
    if (!env.RELAY_KEY || url.searchParams.get('k') !== env.RELAY_KEY) return new Response('forbidden', { status: 403 });

    let target;
    try { target = new URL(url.searchParams.get('u') || ''); } catch { return new Response('bad url', { status: 400 }); }
    if (target.protocol !== 'https:' || !ALLOW.some(re => re.test(target.hostname)))
      return new Response('host not allowed', { status: 403 });

    const headers = { 'User-Agent': UA };            // a standard browser UA only - no forged Referer/Origin
    const range = req.headers.get('Range');
    if (range) headers.Range = range;
    const r = await fetch(target.toString(), { headers, redirect: 'follow' });

    const isPlaylist = r.ok && (/mpegurl/i.test(r.headers.get('content-type') || '') || /\.m3u8($|\?)/i.test(target.pathname + target.search));
    if (!isPlaylist) {
      const out = new Headers();
      for (const k of PASS) { const v = r.headers.get(k); if (v) out.set(k, v); }
      out.set('access-control-allow-origin', '*');
      return new Response(r.body, { status: r.status, headers: out });
    }

    // HLS playlist: rewrite each child URI (segment lines and URI="..." attributes) to an absolute relay URL,
    // so the whole ladder flows through Israel. String work only - well under the free plan's per-request CPU.
    const final = r.url || target.toString();
    const dir = final.slice(0, final.lastIndexOf('/') + 1);
    const origin = new URL(final).origin;
    const key = encodeURIComponent(env.RELAY_KEY);
    const wrap = ref => {
      const abs = /^https?:\/\//i.test(ref) ? ref : ref.startsWith('/') ? origin + ref : dir + ref;
      const q = abs.indexOf('?');
      const path = q < 0 ? abs : abs.slice(0, q);
      const name = path.slice(path.lastIndexOf('/') + 1) || 'x';
      return `${url.origin}/r/${name}?k=${key}&u=${encodeURIComponent(abs)}`;
    };
    const text = await r.text();
    const body = text.split('\n').map(line => {
      const l = line.replace(/\r$/, '');
      if (!l) return l;
      if (l.charCodeAt(0) === 35 /* # */) return l.indexOf('URI="') < 0 ? l : l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
      return wrap(l.trim());
    }).join('\n');
    return new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  },
};
