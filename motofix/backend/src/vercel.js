// Punto de entrada serverless (Vercel). Reemplaza a server.js: no hay listen() ni setInterval,
// así que las tareas periódicas se ejecutan bajo demanda (con límite de frecuencia) y por cron.
import { config } from './config.js';
import { db, get, isRemote, resetData } from './db.js';
import { createHandler } from './lib/http.js';
import { buildRouter } from './routes/index.js';
import { detect } from './anomaly.js';
import { ensureApDefaults, RULE_COUNT, SETTINGS_COUNT } from './services/ap.js';
import { runScheduledReports } from './services/ap-report.js';

if (!isRemote) console.warn('[motofix] Sin TURSO_DATABASE_URL: los datos se guardan en /tmp y se pierden en cada reinicio.');

// Valores por defecto de CxP: solo si faltan (evita decenas de consultas en cada arranque en frío).
const counts = get('SELECT (SELECT COUNT(*) FROM ap_risk_weights) w, (SELECT COUNT(*) FROM ap_settings) s');
if (counts.w < RULE_COUNT || counts.s < SETTINGS_COUNT) ensureApDefaults();

if (!isRemote && config.autoSeed && !get('SELECT COUNT(*) n FROM users').n) {
  const { seed } = await import('./seed.js');
  await seed();
}

const handle = createHandler(buildRouter());

// El motor de IA re-evalúa como máximo una vez por minuto por instancia (es idempotente).
const DETECT_EVERY_MS = 60_000;
let lastDetect = 0;
function maybeDetect() {
  if (Date.now() - lastDetect < DETECT_EVERY_MS) return;
  lastDetect = Date.now();
  try { detect(); } catch (e) { console.error('[ia]', e); }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  // vercel.json reescribe /api/* → /api?__p=*; se restaura la ruta original para el router.
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('__p')) {
    const p = url.searchParams.get('__p');
    url.searchParams.delete('__p');
    if (!url.pathname.startsWith('/api/') || url.pathname === '/api/index' || url.pathname === '/api/index.mjs') url.pathname = `/api/${p}`;
    req.url = url.pathname + (url.search || '');
  }

  // Cron de Vercel (diario en plan Hobby): motor de IA + reporte semanal de riesgo.
  if (req.url.split('?')[0] === '/api/cron/tick') {
    if (!config.cronSecret || req.headers.authorization !== `Bearer ${config.cronSecret}`) return json(res, 401, { error: 'NO_AUTORIZADO' });
    const created = detect();
    lastDetect = Date.now();
    const report = runScheduledReports();
    return json(res, 200, { ok: true, anomalies: created.length, report: report ? report.id ?? true : null });
  }

  // Configuración inicial (una vez): carga los datos de demostración en Turso.
  //   https://<tu-app>.vercel.app/api/setup?clave=<CRON_SECRET>      (solo si la base está vacía)
  //   …&reiniciar=1                                                   (borra todo y recarga la demo)
  if (req.url.split('?')[0] === '/api/setup') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const key = q.get('clave') || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!config.cronSecret || key !== config.cronSecret) return json(res, 401, { error: 'NO_AUTORIZADO', message: 'Falta ?clave= con el valor de CRON_SECRET' });
    if (!isRemote) return json(res, 409, { error: 'SIN_TURSO', message: 'Configura TURSO_DATABASE_URL y TURSO_AUTH_TOKEN en Vercel' });
    const users = get('SELECT COUNT(*) n FROM users').n;
    if (users && q.get('reiniciar') !== '1') return json(res, 409, { error: 'YA_CONFIGURADA', message: `La base ya tiene ${users} usuario(s). Agrega &reiniciar=1 para borrarla y recargar la demo.` });
    const { seedToFile, copyToRemote } = await import('./tools/turso-copy.js');
    const t0 = Date.now();
    const { file, log } = seedToFile();
    const counts = copyToRemote(file, db, resetData);
    lastDetect = 0;
    return json(res, 200, { ok: true, seed: log, rows: Object.values(counts).reduce((a, b) => a + b, 0), ms: Date.now() - t0, next: 'Abre la app e ingresa con una cuenta demo (contraseña MotoFix2026!).' });
  }

  if (req.method === 'GET' && /^\/api\/(dashboard|notifications|ai)/.test(req.url)) maybeDetect();
  return handle(req, res);
}
