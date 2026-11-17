import crypto from 'node:crypto';
import { get, all, run } from './db.js';

const GENESIS = '0'.repeat(64);

const fieldsOf = (r) => [r.prev_hash, r.ts, r.user_id ?? '', r.user_name, r.role, r.action, r.entity ?? '', r.entity_id ?? '', r.detail ?? '', r.ip ?? '', r.device ?? ''].join('|');
const hashOf = (r) => crypto.createHash('sha256').update(fieldsOf(r)).digest('hex');

/**
 * Registra un evento en la bitácora. Cada fila incluye el hash de la anterior (cadena),
 * y la BD rechaza UPDATE/DELETE mediante triggers: la bitácora es append-only y verificable.
 * Como node:sqlite es síncrono, leer el último hash e insertar es atómico dentro del event loop.
 */
export function logEvent({ user = null, action, entity = null, entityId = null, detail = null, ip = null, device = null, ts = null, userName = null, role = null }) {
  const last = get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const row = {
    prev_hash: last?.hash || GENESIS,
    ts: ts || new Date().toISOString(),
    user_id: user?.id ?? null,
    user_name: user?.name || userName || 'Anónimo',
    role: user?.role || role || '—',
    action, entity, entity_id: entityId == null ? null : String(entityId),
    detail: detail ? String(detail).slice(0, 500) : null, ip, device,
  };
  row.hash = hashOf(row);
  const r = run(
    `INSERT INTO audit_log (ts,user_id,user_name,role,action,entity,entity_id,detail,ip,device,prev_hash,hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.ts, row.user_id, row.user_name, row.role, row.action, row.entity, row.entity_id, row.detail, row.ip, row.device, row.prev_hash, row.hash,
  );
  return Number(r.lastInsertRowid);
}

/** Recalcula toda la cadena y reporta el primer registro alterado, si lo hay. */
export function verifyChain() {
  const rows = all('SELECT * FROM audit_log ORDER BY id ASC');
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || hashOf(r) !== r.hash) return { ok: false, count: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, count: rows.length, lastHash: prev };
}

export const ctxLog = (ctx, action, entity, entityId, detail) =>
  logEvent({ user: ctx.user, action, entity, entityId, detail, ip: ctx.ip, device: ctx.device });
