// Share target: Android "Share" of an APK file or a link lands here as POST /share (see manifest.webmanifest).
// A file is parked in the Cache API and the page picks it up (?share=file); text/links go in the query string.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const f = form.get('file');
      if (f && typeof f === 'object' && f.size) {
        const c = await caches.open('share');
        await c.put('/shared-file', new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name || 'shared.apk') } }));
        return Response.redirect('/?share=file', 303);
      }
      const text = [form.get('url'), form.get('text'), form.get('title')].filter(Boolean).join(' ');
      return Response.redirect('/?share=text&text=' + encodeURIComponent(text), 303);
    })());
  }
  // everything else: straight to the network (the page is tiny; no offline cache needed)
});
