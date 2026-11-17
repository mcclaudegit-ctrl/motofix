// Importación de bases de datos externas (SQLite) y de CSV. Solo lectura, con validación de identificadores.
// Flujo: 1) inspeccionar (lista tablas/columnas y muestra) → 2) mapear columnas a campos CxP → 3) ejecutar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../lib/http.js';
import { isRemote, run, get } from '../db.js';
import { logEvent } from '../audit.js';
import { ingest } from './ap.js';

// Vercel limita el cuerpo de una solicitud a 4,5 MB; en servidor propio se aceptan 20 MB.
export const MAX_IMPORT_BYTES = (process.env.VERCEL ? 4 : 20) * 1024 * 1024;
export const MAX_ROWS = 5000;
export const FIELDS = {
  vendor_name: { label: 'Nombre del proveedor', required: true },
  invoice_number: { label: 'Número de factura', required: true },
  issue_date: { label: 'Fecha de emisión', required: true },
  total: { label: 'Total', required: true },
  tax_id: { label: 'Cédula del proveedor' },
  currency: { label: 'Moneda' },
  subtotal: { label: 'Subtotal' },
  tax: { label: 'IVA' },
  category: { label: 'Categoría' },
  bank_account: { label: 'Cuenta bancaria' },
  description: { label: 'Descripción' },
};
const HINTS = {
  vendor_name: ['proveedor', 'vendor', 'nombre', 'supplier', 'razon'],
  invoice_number: ['factura', 'numero', 'number', 'invoice', 'doc'],
  issue_date: ['fecha', 'date', 'emision'],
  total: ['total', 'monto', 'amount', 'importe'],
  tax_id: ['cedula', 'ruc', 'tax', 'nit', 'identificacion', 'rut'],
  currency: ['moneda', 'currency', 'divisa'],
  subtotal: ['subtotal', 'base'],
  tax: ['iva', 'impuesto', 'vat'],
  category: ['categoria', 'category', 'rubro', 'tipo'],
  bank_account: ['cuenta', 'iban', 'bank', 'banco'],
  description: ['descripcion', 'detalle', 'description', 'concepto', 'glosa'],
};
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const quote = (id) => { if (!ID_RE.test(id)) throw new HttpError(422, 'VALIDACION', `Nombre de columna o tabla no válido: ${id}`); return `"${id}"`; };
const stage = new Map(); // token → { kind, file?, headers?, rows?, expires }

function sweep() {
  const now = Date.now();
  for (const [t, s] of stage) if (s.expires < now) { if (s.file) try { fs.rmSync(s.file, { force: true }); } catch { /* ignorar */ } stage.delete(t); }
  if (isRemote) run('DELETE FROM ap_import_stage WHERE expires < ?', now);
}

// En serverless (Turso) el segundo paso puede llegar a otra instancia: la carga también se
// respalda en la base y se recupera desde ahí si no está en la memoria de esta instancia.
function persistStage(token, s, buf) {
  if (!isRemote) return;
  const { file, ...meta } = s;
  run('INSERT INTO ap_import_stage (token, meta, content, expires) VALUES (?,?,?,?)', token, JSON.stringify(meta), buf ?? null, s.expires);
}
function loadStage(token) {
  if (stage.has(token) || !isRemote) return stage.get(token);
  const r = get('SELECT meta, content, expires FROM ap_import_stage WHERE token = ? AND expires >= ?', token, Date.now());
  if (!r) return undefined;
  const s = JSON.parse(r.meta);
  if (r.content) {
    s.file = path.join(os.tmpdir(), `motofix-import-${token}.db`);
    fs.writeFileSync(s.file, r.content, { mode: 0o600 });
  }
  stage.set(token, s);
  return s;
}
function dropStage(token) {
  stage.delete(token);
  if (isRemote) run('DELETE FROM ap_import_stage WHERE token = ?', token);
}

export function suggestMapping(columns) {
  const map = {};
  for (const [field, words] of Object.entries(HINTS)) {
    const hit = columns.find((c) => words.some((w) => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(w)));
    if (hit) map[field] = hit;
  }
  return map;
}

function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...data] = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!headers) throw new HttpError(422, 'ARCHIVO_VACIO', 'El CSV no tiene encabezados');
  const objs = data.slice(0, MAX_ROWS).map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ''])));
  return { headers: headers.map((h) => h.trim()), rows: objs, total: data.length };
}

/** Inspecciona el archivo subido y devuelve un token de importación de 15 minutos. */
export function inspectUpload(buf, name = 'archivo') {
  sweep();
  if (!buf?.length) throw new HttpError(422, 'ARCHIVO_VACIO', 'El archivo está vacío');
  if (buf.length > MAX_IMPORT_BYTES) throw new HttpError(413, 'PAYLOAD_GRANDE', `El archivo supera ${MAX_IMPORT_BYTES / 1e6} MB`);
  const token = crypto.randomBytes(16).toString('hex');
  const isSqlite = buf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0';
  if (isSqlite) {
    const file = path.join(os.tmpdir(), `motofix-import-${token}.db`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name).filter((n) => ID_RE.test(n));
      const tables = names.map((t) => {
        const cols = db.prepare(`PRAGMA table_info(${quote(t)})`).all().map((c) => c.name).filter((c) => ID_RE.test(c));
        const count = db.prepare(`SELECT COUNT(*) n FROM ${quote(t)}`).get().n;
        const sample = db.prepare(`SELECT * FROM ${quote(t)} LIMIT 3`).all();
        return { name: t, columns: cols, rows: count, sample, suggested: suggestMapping(cols) };
      });
      stage.set(token, { kind: 'sqlite', file, tables, expires: Date.now() + 15 * 60e3 });
      persistStage(token, stage.get(token), buf);
      return { token, kind: 'sqlite', name, tables };
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignorar */ }
      throw new HttpError(422, 'SQLITE_INVALIDO', `No se pudo leer la base de datos: ${e.message}`);
    } finally { db?.close(); }
  }
  const text = buf.toString('utf8');
  const parsed = parseCsv(text);
  stage.set(token, { kind: 'csv', label: name, headers: parsed.headers, rows: parsed.rows, total: parsed.total, expires: Date.now() + 15 * 60e3 });
  persistStage(token, stage.get(token));
  return { token, kind: 'csv', name, tables: [{ name: name, columns: parsed.headers, rows: parsed.total, sample: parsed.rows.slice(0, 3), suggested: suggestMapping(parsed.headers) }] };
}

/** Ejecuta la importación con el mapeo elegido. Cada fila pasa por la misma limpieza y motor de riesgo. */
export function runImport({ token, table, mapping }, actor, { ip, device }) {
  sweep();
  const s = loadStage(token);
  if (!s) throw new HttpError(410, 'IMPORTACION_EXPIRADA', 'La carga expiró. Vuelve a subir el archivo.');
  const map = mapping || {};
  for (const f of Object.keys(FIELDS)) if (map[f]) quote(map[f]);
  for (const f of Object.entries(FIELDS).filter(([, m]) => m.required).map(([k]) => k)) {
    if (!map[f]) throw new HttpError(422, 'VALIDACION', `Falta mapear el campo obligatorio: ${FIELDS[f].label}`);
  }
  let records;
  if (s.kind === 'sqlite') {
    const t = s.tables.find((x) => x.name === table);
    if (!t) throw new HttpError(422, 'VALIDACION', 'Tabla no encontrada en la base cargada');
    for (const col of Object.values(map)) if (!t.columns.includes(col)) throw new HttpError(422, 'VALIDACION', `Columna inexistente: ${col}`);
    const db = new DatabaseSync(s.file, { readOnly: true });
    try {
      const cols = [...new Set(Object.values(map))];
      const sql = `SELECT ${cols.map(quote).join(', ')} FROM ${quote(t.name)} LIMIT ${MAX_ROWS}`;
      records = db.prepare(sql).all();
    } finally { db.close(); }
  } else {
    records = s.rows;
  }
  let created = 0; let flagged = 0; let withIssues = 0; const errors = [];
  records.forEach((row, i) => {
    const raw = Object.fromEntries(Object.entries(FIELDS).filter(([f]) => map[f]).map(([f]) => [f, row[map[f]] ?? null]));
    try {
      const inv = ingest(raw, { source: 'importado', actor, ip, device, rawText: `import:${table || s.label}#${i + 1}` });
      created++;
      if (inv.needs_human_review) withIssues++;
      if (inv.risk_level !== 'bajo') flagged++;
    } catch (e) {
      if (errors.length < 20) errors.push({ fila: i + 1, error: e.message });
    }
  });
  logEvent({ user: actor, action: 'CXP_IMPORTACION', entity: 'importacion', entityId: null, ip, device,
    detail: `${s.kind === 'sqlite' ? 'SQLite' : 'CSV'} · ${table || s.label} · ${created} factura(s) · ${flagged} con riesgo medio/alto · ${errors.length} error(es)` });
  dropStage(token); if (s.file) try { fs.rmSync(s.file, { force: true }); } catch { /* ignorar */ }
  return { created, flagged, needs_review: withIssues, errors, rows_read: records.length, limit: MAX_ROWS };
}
