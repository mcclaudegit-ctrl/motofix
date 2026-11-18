// Aviso de nueva versión: cuando se publica un despliegue nuevo (cada push a main), las personas que
// tienen la app abierta ven un aviso y la página se recarga sola tras una cuenta regresiva.
// Detecta el cambio por la versión del servidor (/api/version) y por la huella (ETag) de app.js y app.css.
(() => {
  const EVERY_MS = 60_000;
  const COUNTDOWN_S = 20;
  let baseline = null; let banner = null; let timer = null; let snoozeUntil = 0;

  async function fingerprint() {
    const parts = [];
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j.version) parts.push('v:' + j.version); }
    } catch { /* sin red: se reintenta luego */ }
    for (const f of ['/app.js', '/app.css']) {
      try {
        const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
        const tag = r.headers.get('etag') || r.headers.get('last-modified');
        if (tag) parts.push(f + ':' + tag);
      } catch { /* sin red */ }
    }
    return parts.length ? parts.join('|') : null;
  }

  function show() {
    if (banner || Date.now() < snoozeUntil) return;
    let left = COUNTDOWN_S;
    banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;width:min(560px,calc(100vw - 20px));'
      + 'background:#303a41;color:#fff;border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.3);padding:14px 16px;'
      + 'font:500 14px/1.4 "IBM Plex Sans",system-ui,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
    const msg = document.createElement('div');
    msg.style.cssText = 'flex:1 1 240px';
    const title = document.createElement('b'); title.textContent = 'Hay una nueva versión de MotoFix.';
    const text = document.createElement('span');
    msg.append(title, document.createElement('br'), text);
    const btn = (label, primary) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = `border:0;border-radius:8px;padding:8px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;${primary ? 'background:#3a86b4;color:#fff' : 'background:transparent;color:#cfe3ee;border:1px solid #5b6a74'}`; return b; };
    const now = btn('Actualizar ahora', true);
    const later = btn('En 5 minutos', false);
    now.onclick = () => location.reload();
    later.onclick = () => { snoozeUntil = Date.now() + 5 * 60_000; clearInterval(timer); banner.remove(); banner = null; };
    banner.append(msg, later, now);
    document.body.appendChild(banner);
    const tick = () => {
      text.textContent = `La página se actualizará en ${left} s para aplicar los cambios. Guarda lo que estés escribiendo.`;
      if (left-- <= 0) location.reload();
    };
    tick(); timer = setInterval(tick, 1000);
  }

  async function check() {
    if (document.hidden) return;
    const fp = await fingerprint();
    if (!fp) return;
    if (baseline === null) { baseline = fp; return; }
    if (fp !== baseline) show();
  }

  check();
  setInterval(check, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.__motofixCheckUpdate = check; // útil para probar
})();
