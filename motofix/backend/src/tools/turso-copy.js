// Carga los datos de demostración en Turso: genera la semilla en un SQLite local temporal
// (rápido, sin red) y la copia por lotes. Evita miles de viajes de red, uno por fila.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed.js');
const BATCH = 250;

/** Corre seed.js en un proceso aparte contra un archivo local y devuelve su ruta. */
export function seedToFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motofix-seed-'));
  const file = path.join(dir, 'seed.db');
  const env = { ...process.env, DB_PATH: file, DATA_DIR: dir, AUTO_SEED: 'false', JWT_SECRET: 'solo-para-sembrar' };
  delete env.TURSO_DATABASE_URL; delete env.TURSO_AUTH_TOKEN;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SEED, '--reset'], { env, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`La semilla falló: ${(r.stderr || r.stdout || r.error?.message || '').slice(-500)}`);
  return { file, log: (r.stdout || '').trim().split('\n').pop() };
}

/** Copia todas las tablas de `localFile` a la base remota (que ya tiene el esquema). */
export function copyToRemote(localFile, remote, resetData) {
  const src = new DatabaseSync(localFile, { readOnly: true });
  try {
    resetData();                          // vacía la remota y desactiva triggers de inmutabilidad
    remote.exec('PRAGMA foreign_keys = OFF;');
    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
    const counts = {};
    for (const t of tables) {
      const cols = src.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      const stmt = src.prepare(`SELECT * FROM "${t}" ORDER BY rowid`);
      stmt.setReadBigInts(true);           // conserva enteros como INTEGER (no REAL) en la copia
      const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      let batch = []; counts[t] = 0;
      for (const row of stmt.iterate()) {
        batch.push({ sql, args: cols.map((c) => row[c]) });
        if (batch.length >= BATCH) { counts[t] += remote.executeBatch(batch); batch = []; }
      }
      if (batch.length) counts[t] += remote.executeBatch(batch);
    }
    return counts;
  } finally {
    remote.exec('PRAGMA foreign_keys = ON;');
    src.close();
  }
}
