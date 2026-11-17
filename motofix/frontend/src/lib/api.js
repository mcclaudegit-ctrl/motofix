// Cliente HTTP. Centraliza el token, los errores y los pop-ups de seguridad (PRD 1.1.4).
let token = null;
try { token = sessionStorage.getItem('motofix_token'); } catch { /* storage no disponible */ }

export const getToken = () => token;
export function setToken(t) {
  token = t;
  try { t ? sessionStorage.setItem('motofix_token', t) : sessionStorage.removeItem('motofix_token'); } catch { /* noop */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Error de red');
    this.status = status; this.code = body?.error; this.body = body || {};
  }
}

const listeners = new Set();
export const onSecurityEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const SECURITY_CODES = new Set(['PERMISO_DENEGADO', 'BITACORA_INMUTABLE', 'FACTURA_DUPLICADA']);
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body, { quiet = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'No se pudo conectar con el servidor' });
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    const data = type.includes('json') ? await res.json().catch(() => ({})) : {};
    const err = new ApiError(res.status, data);
    if (res.status === 401 && token && url !== '/api/auth/login') onUnauthorized();
    if (!quiet && SECURITY_CODES.has(data.error)) listeners.forEach((fn) => fn({ ...data, status: res.status }));
    throw err;
  }
  return type.includes('json') ? res.json() : res;
}

export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b, o) => api('POST', u, b ?? {}, o);
export const put = (u, b, o) => api('PUT', u, b ?? {}, o);
export const patch = (u, b, o) => api('PATCH', u, b ?? {}, o);
export const del = (u, o) => api('DELETE', u, undefined, o);

/** Registra interacciones de interfaz en la bitácora (navegación y clics relevantes). Nunca bloquea la UI. */
export function track(action, target, detail) {
  if (!token) return;
  api('POST', '/api/audit/ui-event', { action, target, detail }, { quiet: true }).catch(() => {});
}

export async function download(url, fallbackName) {
  const res = await api('GET', url);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
