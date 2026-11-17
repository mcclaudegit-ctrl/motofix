// Adaptador Turso (libSQL por HTTP) contra un servidor Hrana v2 simulado sobre node:sqlite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RemoteDatabase } from '../src/lib/libsql/remote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motofix-remote-'));
const port = 20000 + Math.floor(Math.random() * 20000);
let srv; let db;

before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, 'helpers/fake-hrana.js'), String(port), path.join(dir, 'r.db'), '400'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
  db = new RemoteDatabase(`http://127.0.0.1:${port}`, 'tok');
  db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id), v REAL, t TEXT, b BLOB, x)');
});
after(() => { db?.close(); srv?.kill(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('tipos y lastInsertRowid iguales a node:sqlite', () => {
  db.prepare('INSERT INTO p VALUES (?)').run(1);
  const r = db.prepare('INSERT INTO c (pid,v,t,b,x) VALUES (?,?,?,?,?)').run(1, 2.5, 'á', Buffer.from([1, 2]), 5);
  assert.equal(r.changes, 1); assert.equal(r.lastInsertRowid, 1);
  const row = db.prepare('SELECT *, typeof(x) tx FROM c').get();
  assert.deepEqual({ ...row, b: [...row.b] }, { id: 1, pid: 1, v: 2.5, t: 'á', b: [1, 2], x: 5, tx: 'real' });
});

test('la sesión se recupera si el servidor la vence y conserva PRAGMA foreign_keys', async () => {
  await sleep(600);
  assert.throws(() => db.prepare('INSERT INTO c (pid) VALUES (?)').run(99), /FOREIGN KEY/);
  db.exec('PRAGMA foreign_keys = OFF;');
  await sleep(600);
  db.prepare('INSERT INTO c (pid) VALUES (?)').run(99);
  db.exec('PRAGMA foreign_keys = ON;');
});

test('transacciones: ROLLBACK descarta y COMMIT confirma', () => {
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO p VALUES (?)').run(5); db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM p WHERE id=5').get().n, 0);
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO p VALUES (?)').run(6); db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM p WHERE id=6').get().n, 1);
});

test('carga por lotes y errores SQL legibles', () => {
  const n = db.executeBatch(Array.from({ length: 300 }, (_, i) => ({ sql: 'INSERT INTO p VALUES (?)', args: [BigInt(100 + i)] })));
  assert.equal(n, 300);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM p').get().n, 302);
  assert.throws(() => db.prepare('SELEC 1').all(), /syntax error/);
});

test('token inválido da un error claro', () => {
  const bad = new RemoteDatabase(`http://127.0.0.1:${port}`, 'malo');
  try { assert.throws(() => bad.prepare('SELECT 1').get(), /Turso HTTP 401/); } finally { bad.close(); }
});
