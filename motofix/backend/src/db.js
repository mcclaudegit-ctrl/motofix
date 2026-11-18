import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { RemoteDatabase } from './lib/libsql/remote.js';
import { LATER_GRANTS } from './permissions.js';

// Con TURSO_DATABASE_URL la base vive en Turso (libSQL en la nube, necesario en Vercel,
// donde el disco no persiste). Sin ella se usa el archivo SQLite local de siempre.
export const isRemote = Boolean(config.tursoUrl);
export const db = isRemote ? new RemoteDatabase(config.tursoUrl, config.tursoToken) : new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
export const get = (sql, ...p) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
export const run = (sql, ...p) => db.prepare(sql).run(...p);

/** Transacción síncrona: commit si la función retorna, rollback si lanza. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','gerente','contador','auditor','recepcionista','ventas','proveedor')),
  supplier_id INTEGER REFERENCES suppliers(id),
  demo_key TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tax_id TEXT,
  contact_email TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  id_number TEXT,
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('repuesto','insumo','servicio')),
  price INTEGER NOT NULL CHECK (price >= 0),
  cost INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('venta','compra','ajuste','anulacion')),
  ref_type TEXT, ref_id INTEGER, note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  motorcycle TEXT NOT NULL,
  plate TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('abierta','en_proceso','completada','facturada','cancelada')),
  labor_amount INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS work_order_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('venta','servicio')),
  customer_id INTEGER REFERENCES customers(id),
  work_order_id INTEGER REFERENCES work_orders(id),
  quote_id INTEGER,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pendiente','pagada','anulada')),
  content_hash TEXT NOT NULL,
  discount_approved_by INTEGER REFERENCES users(id),
  override_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  paid_at TEXT,
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_hash ON invoices(content_hash);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('cotizacion','precuenta')),
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT,
  items_json TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('borrador','enviada','aceptada','facturada')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  number TEXT NOT NULL,
  description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pendiente','aprobada','pagada','rechazada')),
  source TEXT NOT NULL CHECK (source IN ('portal','interno')),
  delivery_confirmed INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',
  stock_applied INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  reject_reason TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (supplier_id, number)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('anulacion','descuento')),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  pct REAL,
  status TEXT NOT NULL CHECK (status IN ('pendiente','aprobada','rechazada')),
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('alta','media','baja')),
  score INTEGER NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id INTEGER,
  ref_label TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','revisada','descartada')),
  dedupe_key TEXT NOT NULL UNIQUE,
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL,            -- 'security' (roles con notifications.security) | 'user'
  user_id INTEGER REFERENCES users(id),
  level TEXT NOT NULL CHECK (level IN ('info','warning','critical')),
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Bitácora inmutable (PRD 1.5.2 / 1.6.2): encadenada por hash y protegida por triggers.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  device TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

`);

export const AP_SCHEMA = `
CREATE TABLE IF NOT EXISTS ap_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tax_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_key TEXT NOT NULL,
  category TEXT, bank_account TEXT, bank_account_changed_at TEXT, contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'activo', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ap_employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, national_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_key TEXT NOT NULL,
  bank_account TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ap_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL, number_key TEXT NOT NULL,
  vendor_id INTEGER REFERENCES ap_vendors(id),
  vendor_tax_id TEXT, vendor_name TEXT NOT NULL, vendor_name_key TEXT NOT NULL,
  issue_date TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'CRC', exchange_rate REAL NOT NULL DEFAULT 1,
  subtotal REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, total_crc REAL NOT NULL DEFAULT 0,
  category TEXT, description TEXT, bank_account TEXT,
  source TEXT NOT NULL CHECK (source IN ('correo','xml','pdf','manual','importado','taller')),
  status TEXT NOT NULL CHECK (status IN ('en_revision','aprobada_parcial','aprobada','rechazada')),
  required_approvals INTEGER NOT NULL DEFAULT 1,
  approved_1_by INTEGER REFERENCES users(id), approved_1_at TEXT,
  approved_2_by INTEGER REFERENCES users(id), approved_2_at TEXT,
  reject_reason TEXT, approval_note TEXT,
  cleaning_log TEXT NOT NULL DEFAULT '[]', quality_issues TEXT NOT NULL DEFAULT '[]',
  needs_human_review INTEGER NOT NULL DEFAULT 0,
  inbox_id INTEGER, raw_text TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'bajo',
  findings TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ap_vendor_tax ON ap_invoices(vendor_tax_id);
CREATE INDEX IF NOT EXISTS idx_ap_number ON ap_invoices(number_key);
CREATE INDEX IF NOT EXISTS idx_ap_status ON ap_invoices(status);
CREATE TABLE IF NOT EXISTS ap_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL CHECK (direction IN ('entrada','salida')),
  counterpart TEXT NOT NULL, subject TEXT NOT NULL, body TEXT, attachments TEXT NOT NULL DEFAULT '[]',
  scenario TEXT, outcome TEXT NOT NULL, extractor TEXT, invoice_id INTEGER REFERENCES ap_invoices(id), received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ap_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS ap_risk_weights (rule TEXT PRIMARY KEY, label TEXT NOT NULL, weight INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100));
CREATE TABLE IF NOT EXISTS ap_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, format TEXT NOT NULL, title TEXT NOT NULL,
  content BLOB NOT NULL, scheduled INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ap_import_stage (token TEXT PRIMARY KEY, meta TEXT NOT NULL, content BLOB, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ap_upload_chunks (
  upload_id TEXT NOT NULL, part INTEGER NOT NULL, total INTEGER NOT NULL, user_id INTEGER NOT NULL,
  content BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (upload_id, part));
`;
db.exec(AP_SCHEMA);

export const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable: no se permite modificar registros'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable: no se permite eliminar registros'); END;
`;
db.exec(TRIGGERS_SQL);

// Rebranding «IA» → «Auditor Inteligente» (18-11-2026): corrige las notificaciones ya guardadas.
// Idempotente: después de la primera vez ya no hay filas que coincidan. La bitácora (audit_log) no se toca.
db.exec(`
UPDATE notifications SET title = 'Alerta del Auditor Inteligente: ' || substr(title, 12) WHERE title LIKE 'Alerta IA: %';
UPDATE notifications SET link = '/auditor-inteligente' WHERE link = '/ia';
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`);

// Permisos nuevos en bases ya cargadas: se otorgan una sola vez (marca en app_meta).
{
  const done = new Set(db.prepare('SELECT key FROM app_meta').all().map((r) => r.key));
  const pending = LATER_GRANTS.filter((g) => !done.has(g.key));
  if (pending.length) {
    const seeded = db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
    for (const g of pending) {
      if (seeded) for (const role of g.roles) db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)').run(role, g.permission);
      db.prepare('INSERT OR IGNORE INTO app_meta (key, value, updated_at) VALUES (?,?,?)').run(g.key, seeded ? 'otorgado' : 'base nueva', new Date().toISOString());
    }
  }
}

/** Borra TODOS los datos (solo para re-sembrar). Desactiva temporalmente los triggers de inmutabilidad. */
export function resetData() {
  db.exec('DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete; PRAGMA foreign_keys = OFF;');
  for (const t of ['audit_log','notifications','anomalies','approval_requests','supplier_invoices','quotes','invoice_items','invoices','work_order_parts','work_orders','stock_movements','products','customers','ap_invoices','ap_inbox','ap_vendors','ap_employees','ap_reports','ap_import_stage','ap_upload_chunks','ap_risk_weights','ap_settings','role_permissions','users','suppliers'])
    db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM sqlite_sequence; PRAGMA foreign_keys = ON;");
  db.exec(TRIGGERS_SQL);
}
