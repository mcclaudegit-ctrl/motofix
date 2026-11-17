import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Respuesta no-JSON (CSV, etc.). */
export class Raw {
  constructor(body, contentType, headers = {}) {
    this.body = body;
    this.contentType = contentType;
    this.headers = headers;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

export function parseDevice(ua = '') {
  const browser =
    /Edg\/([\d.]+)/.exec(ua)?.[0].replace('Edg/', 'Edge ') ||
    /OPR\/([\d.]+)/.exec(ua)?.[0].replace('OPR/', 'Opera ') ||
    /Chrome\/(\d+)/.exec(ua)?.[0].replace('Chrome/', 'Chrome ') ||
    /Firefox\/(\d+)/.exec(ua)?.[0].replace('Firefox/', 'Firefox ') ||
    (/Safari\//.test(ua) && /Version\/(\d+)/.exec(ua)?.[0].replace('Version/', 'Safari ')) ||
    (ua ? ua.slice(0, 30) : 'Desconocido');
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '—';
  return `${String(browser).split('.')[0]} · ${os}`;
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (config.trustProxy && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

const rateBuckets = new Map();
/** Limitador simple en memoria: máx `limit` solicitudes por `windowMs` por clave. */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    rateBuckets.set(key, arr);
    throw new HttpError(429, 'DEMASIADAS_SOLICITUDES', 'Demasiadas solicitudes. Intenta de nuevo en un momento.');
  }
  arr.push(now);
  rateBuckets.set(key, arr);
}
export const resetRateLimits = () => rateBuckets.clear();

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...chain) {
    const handler = chain.pop();
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, mws: chain, handler });
  }
  get(p, ...c) { this.add('GET', p, ...c); }
  /** Ruta que recibe el cuerpo sin interpretarlo (CSV o SQLite). Se expone en ctx.rawBody. */
  postRaw(p, ...c) { this.add('POST', p, ...c); this.routes[this.routes.length - 1].raw = true; }
  post(p, ...c) { this.add('POST', p, ...c); }
  put(p, ...c) { this.add('PUT', p, ...c); }
  patch(p, ...c) { this.add('PATCH', p, ...c); }
  delete(p, ...c) { this.add('DELETE', p, ...c); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
    }
    return null;
  }
}

async function readRaw(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'PAYLOAD_GRANDE', `El archivo supera ${Math.round(max / 1e6)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'PAYLOAD_GRANDE', 'Solicitud demasiado grande');
    chunks.push(c);
  }
  if (!size) return {};
  const ctype = req.headers['content-type'] || '';
  if (!ctype.includes('application/json')) throw new HttpError(415, 'TIPO_NO_SOPORTADO', 'Se espera application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON_INVALIDO', 'El cuerpo no es JSON válido'); }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function serveStatic(req, res, pathname) {
  const root = config.staticDir;
  if (!fs.existsSync(root)) {
    return sendJson(res, 404, { error: 'SIN_FRONTEND', message: 'Frontend no compilado. Ejecuta "npm run build" en /frontend.' });
  }
  let file = path.join(root, path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) return sendJson(res, 403, { error: 'PROHIBIDO' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(pathname)) return sendJson(res, 404, { error: 'NO_ENCONTRADO', message: 'Recurso no encontrado' });
    file = path.join(root, 'index.html'); // fallback SPA
  }
  const ext = path.extname(file);
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

export function createApp(router) {
  return http.createServer(createHandler(router));
}

/** Manejador (req, res) reutilizable: servidor propio (createApp) o función serverless (Vercel). */
export function createHandler(router) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const t0 = Date.now();
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'METODO_NO_PERMITIDO' });
        return serveStatic(req, res, url.pathname);
      }
      const found = router.match(req.method, url.pathname);
      if (!found) {
        // ruta existente con otro método => 405
        const other = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].some((m) => router.match(m, url.pathname));
        throw new HttpError(other ? 405 : 404, other ? 'METODO_NO_PERMITIDO' : 'NO_ENCONTRADO', other ? 'Método no permitido' : 'Ruta no encontrada');
      }
      const ctx = {
        req, res, params: found.params,
        query: Object.fromEntries(url.searchParams),
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !found.route.raw ? await readBody(req) : {},
        rawBody: found.route.raw ? await readRaw(req, 20 * 1024 * 1024) : null,
        ip: clientIp(req), device: parseDevice(req.headers['user-agent']),
        user: null, status: 200,
      };
      for (const mw of found.route.mws) await mw(ctx);
      const out = await found.route.handler(ctx);
      if (out instanceof Raw) {
        res.writeHead(ctx.status, { ...SECURITY_HEADERS, 'Content-Type': out.contentType, 'Cache-Control': 'no-store', ...out.headers });
        res.end(out.body);
      } else {
        sendJson(res, ctx.status, out ?? { ok: true });
      }
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra });
      } else {
        console.error('[error]', req.method, url.pathname, e);
        sendJson(res, 500, { error: 'ERROR_INTERNO', message: 'Ocurrió un error interno' });
      }
    } finally {
      if (process.env.LOG_REQUESTS === 'true') console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  };
}
