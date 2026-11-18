// Carga los datos de demostración en Turso: genera la semilla en un SQLite local temporal
// (rápido, sin red) y la copia por lotes. Evita miles de viajes de red, uno por fila.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed.js');
const BATCH = 400;

/** Corre seed.js en un proceso aparte contra un archivo local y devuelve su ruta. */
export function seedToFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motofix-seed-'));
  const file = path.join(dir, 'seed.db');
  const env = { ...process.env, DB_PATH: file, DATA_DIR: dir, AUTO_SEED: 'false', JWT_SECRET: 'solo-para-sembrar' };
  delete env.TURSO_DATABASE_URL; delete env.TURSO_AUTH_TOKEN; delete env.VERCEL;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SEED, '--reset'], { env, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`La semilla falló: ${(r.stderr || r.stdout || r.error?.message || '').slice(-500)}`);
  return { file, log: (r.stdout || '').trim().split('\n').pop() };
}

/** Un lote de INSERTs en UNA transacción (en Turso cada sentencia suelta confirma por separado y es lenta). */
function insertBatch(remote, batch) {
  try {
    return remote.executeBatch([{ sql: 'BEGIN' }, ...batch, { sql: 'COMMIT' }]) - 2;
  } catch (e) {
    try { remote.exec('ROLLBACK'); } catch { /* sin transacción abierta */ }
    throw e;
  }
}

/**
 * Copia las tablas de `localFile` a la base remota (que ya tiene el esquema).
 * - mode 'reset': vacía la remota y copia todo.
 * - mode 'resume': solo completa tablas vacías o incompletas (retoma una carga cortada).
 * Se detiene al agotar `budgetMs` y devuelve las tablas pendientes para continuar en otra llamada.
 */
export function copyToRemote(localFile, remote, { resetData, triggersSql, mode = 'reset', budgetMs = Infinity } = {}) {
  const t0 = Date.now();
  const src = new DatabaseSync(localFile, { readOnly: true });
  const counts = {}; const pending = [];
  try {
    if (mode === 'reset') resetData();                        // vacía la remota y recrea triggers
    remote.exec('DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete; PRAGMA foreign_keys = OFF;');
    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
    // Al retomar: las tablas se copian en orden alfabético, así que la única que pudo quedar a medias
    // es la última con filas. Las demás con filas se respetan (pueden haber crecido por el uso de la app).
    let remoteCounts = null; let lastTouched = null;
    if (mode === 'resume') {
      remoteCounts = Object.fromEntries(tables.map((t) => [t, remote.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
      lastTouched = [...tables].reverse().find((t) => remoteCounts[t] > 0) || null;
    }
    for (const t of tables) {
      if (Date.now() - t0 > budgetMs) { pending.push(t); continue; }
      const localN = src.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
      if (mode === 'resume') {
        const remoteN = remoteCounts[t];
        if (remoteN > 0 && !(t === lastTouched && remoteN < localN)) continue;
        if (remoteN > 0) remote.exec(`DELETE FROM "${t}";`); // la tabla que quedó a medias se rehace completa
      }
      if (!localN) continue;
      const cols = src.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      const stmt = src.prepare(`SELECT * FROM "${t}" ORDER BY rowid`);
      stmt.setReadBigInts(true);           // conserva enteros como INTEGER (no REAL) en la copia
      const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      let batch = []; counts[t] = 0;
      for (const row of stmt.iterate()) {
        batch.push({ sql, args: cols.map((c) => row[c]) });
        if (batch.length >= BATCH) { counts[t] += insertBatch(remote, batch); batch = []; }
      }
      if (batch.length) counts[t] += insertBatch(remote, batch);
    }
    return { counts, pending, ms: Date.now() - t0 };
  } finally {
    remote.exec(`PRAGMA foreign_keys = ON; ${triggersSql}`);
    src.close();
  }
}
