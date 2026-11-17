import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
// En Vercel el código es de solo lectura: lo temporal va a /tmp (la base vive en Turso).
export const onVercel = Boolean(process.env.VERCEL);
const dataDir = process.env.DATA_DIR || (onVercel ? '/tmp/motofix' : path.join(ROOT, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

// El secreto JWT se toma del entorno; si no existe, se genera uno aleatorio y se persiste
// para que las sesiones sobrevivan a reinicios en desarrollo.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // En serverless cada instancia tendría un secreto distinto y las sesiones se caerían:
  // sin JWT_SECRET se deriva uno estable del token de Turso (que ya es secreto).
  if (process.env.TURSO_AUTH_TOKEN) {
    console.warn('[motofix] JWT_SECRET no definido: se deriva del token de Turso. Defínelo en Vercel.');
    return crypto.createHash('sha256').update(`motofix-jwt:${process.env.TURSO_AUTH_TOKEN}`).digest('hex');
  }
  const f = path.join(dataDir, '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(dataDir, 'motofix.db'),
  tursoUrl: process.env.TURSO_DATABASE_URL || '',
  tursoToken: process.env.TURSO_AUTH_TOKEN || '',
  cronSecret: process.env.CRON_SECRET || '',
  // DEMO_MODE=true habilita el selector de rol simulado (PRD 1.1.1). En producción: false.
  demoMode: (process.env.DEMO_MODE ?? 'true') !== 'false',
  autoSeed: (process.env.AUTO_SEED ?? 'true') !== 'false',
  jwtSecret: loadSecret(),
  tokenTtlSeconds: Number(process.env.TOKEN_TTL || 8 * 3600),
  trustProxy: process.env.TRUST_PROXY === 'true' || onVercel,
  tzOffsetHours: -6, // Costa Rica (UTC-6, sin horario de verano)
  taxRate: 0.13, // IVA
  businessHours: { start: 7, end: 20 }, // fuera de este rango => alerta
  staticDir: process.env.STATIC_DIR || path.resolve(ROOT, '..', 'frontend', 'dist'),
  demoPassword: process.env.DEMO_PASSWORD || 'MotoFix2026!',
  maxExternalSuppliers: 3,
};
