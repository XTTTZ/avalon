// Network-only: never store identities, notes, votes, API responses or room HTML.
// Normal update lifecycle keeps an active game open (no skipWaiting/clients.claim).
const offlinePage = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f6f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101a15" media="(prefers-color-scheme: dark)">
<title>阿瓦隆 · 暂时离线</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #f5f6f2; color: #25352f; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); }
main { max-width: 320px; text-align: center; }
h1 { margin: 0 0 12px; font-size: 24px; }
p { margin: 0; line-height: 1.7; }
button { margin-top: 24px; width: 100%; min-height: 48px; border: 0; border-radius: 8px; background: #245b43; color: white; font: inherit; }
small { display: block; margin-top: 24px; }
@media (prefers-color-scheme: dark) { :root { background: #101a15; color: #e6eee8; } }
</style></head><body><main><h1>暂时离线</h1><p>连接网络后，重新进入房间。</p>
<button type="button" onclick="location.reload()">重新连接</button><small>阿瓦隆圆桌</small></main>
<script>window.addEventListener('online', function () { location.reload(); });</script>
</body></html>`;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  // Only entry navigation gets an offline fallback; API/auth/static assets bypass SW.
  if (
    url.origin !== scope.origin ||
    ![scope.pathname, `${scope.pathname}index.html`].includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(offlinePage, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        }),
    ),
  );
});
