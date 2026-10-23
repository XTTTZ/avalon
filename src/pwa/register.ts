export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    const base = new URL(import.meta.env.BASE_URL, location.href);
    void navigator.serviceWorker
      .register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' })
      .catch(() => {
        // Installation is optional; online gameplay remains available.
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
