// Núcleo de cuentas por pagar: ingreso, motor de hallazgos (módulo 2), riesgo ponderado,
// aprobación con límite y segregación de funciones, y dashboard (módulo 3).
import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { logEvent } from '../audit.js';
import { notify } from '../auth.js';
import { robustZ } from '../anomaly.js';
import { crc, localParts } from '../lib/time.js';
import { cleanRecord, nameKey } from './ap-clean.js';

// Reglas y pesos por defecto (editables desde Configuración; se guardan en ap_risk_weights).
export const RULES = {
  CALIDAD_DATOS: { label: 'Datos mínimos incompletos', weight: 25 },
  DUP_NUMERO: { label: 'Mismo número de factura (mismo canal)', weight: 60 },
  DUP_DOBLE_CANAL: { label: 'Misma factura recibida por dos canales', weight: 55 },
  DUP_MONTO_FECHA: { label: 'Mismo proveedor, monto y fecha', weight: 40 },
  DUP_MONTO_CERCANO: { label: 'Mismo monto con fechas cercanas (±7 días)', weight: 20 },
  PAT_UMBRAL: { label: 'Monto a 5% o menos del límite de aprobación', weight: 15 },
  PAT_FRACCIONAMIENTO: { label: 'Posible fraccionamiento para evadir el límite', weight: 35 },
  PAT_ATIPICO: { label: 'Monto atípico frente al historial del proveedor', weight: 25 },
  PAT_FECHA_FUTURA: { label: 'Fecha de emisión futura', weight: 30 },
  PAT_FIN_SEMANA: { label: 'Factura emitida en domingo', weight: 10 },
  PROV_NO_REGISTRADO: { label: 'Proveedor no registrado en el maestro', weight: 30 },
  PROV_NOMBRE: { label: 'Nombre no coincide con la cédula del maestro', weight: 30 },
  PROV_CEDULA: { label: 'Cédula ausente o inválida', weight: 25 },
  PROV_CUENTA_CAMBIO: { label: 'Cuenta bancaria distinta a la del maestro', weight: 45 },
  PROV_EMPLEADO: { label: 'Proveedor coincide con un empleado (conflicto de interés)', weight: 60 },
};
export const SETTINGS_DEFAULTS = { limite_aprobacion: 700000, tipo_cambio_usd: 510, umbral_medio: 25, umbral_alto: 50 };
const OPEN = ["'en_revision'", "'aprobada_parcial'"];

export const RULE_COUNT = Object.keys(RULES).length;
export const SETTINGS_COUNT = Object.keys(SETTINGS_DEFAULTS).length;

export function ensureApDefaults() {
  for (const [rule, r] of Object.entries(RULES)) run('INSERT OR IGNORE INTO ap_risk_weights (rule,label,weight) VALUES (?,?,?)', rule, r.label, r.weight);
  const now = new Date().toISOString();
  for (const [k, val] of Object.entries(SETTINGS_DEFAULTS)) run('INSERT OR IGNORE INTO ap_settings (key,value,updated_at) VALUES (?,?,?)', k, String(val), now);
}

export function getSettings() {
  const out = { ...SETTINGS_DEFAULTS };
  for (const r of all('SELECT key,value FROM ap_settings')) if (r.key in SETTINGS_DEFAULTS) out[r.key] = Number(r.value);
  return out;
}

export function saveSettings(input, actor, { ip, device }) {
  const S = getSettings(); const changes = [];
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(422, 'VALIDACION', `${k}: debe ser un número ≥ 0`);
    if (k.startsWith('umbral') && (n < 0 || n > 100)) throw new HttpError(422, 'VALIDACION', `${k}: entre 0 y 100`);
    if (n !== S[k]) { changes.push(`${k}: ${S[k]} → ${n}`); S[k] = n; }
    run('INSERT INTO ap_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
      k, String(n), actor.id, new Date().toISOString());
  }
  if (S.umbral_medio >= S.umbral_alto) throw new HttpError(422, 'VALIDACION', 'El umbral medio debe ser menor que el umbral alto');
  if (changes.length) {
    logEvent({ user: actor, action: 'CONFIG_CXP', entity: 'configuracion', detail: changes.join(' · '), ip, device });
    rescoreAll();
  }
  return getSettings();
}

export function getWeights() {
  return all('SELECT rule,label,weight FROM ap_risk_weights ORDER BY rule').map((w) => ({ ...w, default: RULES[w.rule]?.weight ?? null }));
}

export function saveWeights(input, actor, { ip, device }) {
  const changes = [];
  for (const [rule, w] of Object.entries(input || {})) {
    if (!RULES[rule]) throw new HttpError(422, 'VALIDACION', `Regla desconocida: ${rule}`);
    const n = Number(w);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(422, 'VALIDACION', `${rule}: el peso debe ser un entero entre 0 y 100`);
    const prev = get('SELECT weight FROM ap_risk_weights WHERE rule=?', rule)?.weight;
    if (prev !== n) { changes.push(`${rule} ${prev}→${n}`); run('UPDATE ap_risk_weights SET weight=? WHERE rule=?', n, rule); }
  }
  if (changes.length) {
    logEvent({ user: actor, action: 'CONFIG_RIESGO', entity: 'pesos_riesgo', detail: changes.join(' · '), ip, device });
    rescoreAll();
  }
  return getWeights();
}

const dayDiff = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3;
const tokens = (s) => new Set(String(s || '').split(' ').filter((t) => t.length > 1));
function similarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Motor de hallazgos: evalúa una factura contra el resto del histórico y contra el maestro. */
export function evaluateInvoice(inv, S = getSettings(), W = weightMap()) {
  const out = [];
  const add = (rule, detail) => out.push({ rule, label: RULES[rule].label, weight: W[rule], detail });
  const limit = S.limite_aprobacion;

  // Calidad: datos mínimos
  const critical = (inv.quality_issues ? JSON.parse(inv.quality_issues) : []).filter((q) => q.critical).map((q) => q.field);
  if (critical.length) add('CALIDAD_DATOS', `faltan datos mínimos: ${critical.join(', ')}`);

  const others = (inv.vendor_name_key || inv.vendor_tax_id)
    ? all(`SELECT * FROM ap_invoices WHERE id != ? AND status != 'rechazada' AND (vendor_name_key = ? OR (? IS NOT NULL AND vendor_tax_id = ?))`,
      inv.id, inv.vendor_name_key, inv.vendor_tax_id, inv.vendor_tax_id)
    : [];

  // Duplicidad
  const sameNum = others.find((o) => o.number_key && o.number_key === inv.number_key);
  if (sameNum) {
    sameNum.source === inv.source
      ? add('DUP_NUMERO', `ya existe ${sameNum.invoice_number} del mismo proveedor (${sameNum.source})`)
      : add('DUP_DOBLE_CANAL', `${sameNum.invoice_number} llegó por ${sameNum.source} y por ${inv.source}`);
  }
  if (inv.issue_date) {
    const sameAmtDate = others.find((o) => o.number_key !== inv.number_key && Math.abs(o.total_crc - inv.total_crc) < 0.5 && o.issue_date === inv.issue_date);
    if (sameAmtDate) add('DUP_MONTO_FECHA', `${sameAmtDate.invoice_number}: mismo monto ${crc(inv.total_crc)} y fecha ${inv.issue_date}`);
    else {
      const near = others.find((o) => o.number_key !== inv.number_key && o.issue_date && Math.abs(o.total_crc - inv.total_crc) < 0.5 && Math.abs(dayDiff(o.issue_date, inv.issue_date)) <= 7);
      if (near) add('DUP_MONTO_CERCANO', `${near.invoice_number}: mismo monto con fecha a ${Math.abs(dayDiff(near.issue_date, inv.issue_date))} día(s)`);
    }
  }

  // Patrones irregulares
  if (inv.total_crc >= limit * 0.95 && inv.total_crc <= limit) add('PAT_UMBRAL', `${crc(inv.total_crc)} está a ≤5% del límite de ${crc(limit)}`);
  if (inv.issue_date && inv.total_crc < limit) {
    const sib = others.filter((o) => o.issue_date && o.total_crc < limit && Math.abs(dayDiff(o.issue_date, inv.issue_date)) <= 3);
    const sum = sib.reduce((s, o) => s + o.total_crc, inv.total_crc);
    if (sib.length && sum > limit) add('PAT_FRACCIONAMIENTO', `${sib.length + 1} facturas de montos menores al límite suman ${crc(sum)} en 3 días`);
  }
  const hist = others.filter((o) => o.total_crc > 0).map((o) => Math.log(o.total_crc));
  if (hist.length >= 3 && inv.total_crc > 0) {
    const z = robustZ(hist, Math.log(inv.total_crc));
    const med = Math.exp([...hist].sort((a, b) => a - b)[Math.floor(hist.length / 2)]);
    if (z > 2.5 && inv.total_crc >= 2.5 * med) add('PAT_ATIPICO', `${crc(inv.total_crc)} es muy superior al historial del proveedor (z=${z.toFixed(1)})`);
  }
  if (inv.issue_date) {
    const today = localParts(new Date().toISOString()).date;
    if (inv.issue_date > today) add('PAT_FECHA_FUTURA', `fecha ${inv.issue_date} posterior a hoy`);
    if (new Date(`${inv.issue_date}T12:00:00Z`).getUTCDay() === 0) add('PAT_FIN_SEMANA', `fecha ${inv.issue_date} es domingo`);
  }

  // Coincidencia con el maestro de proveedores
  const vendor = inv.vendor_id ? get('SELECT * FROM ap_vendors WHERE id=?', inv.vendor_id) : null;
  if (!vendor) add('PROV_NO_REGISTRADO', `«${inv.vendor_name}» no existe en el maestro${inv.vendor_tax_id ? ` (cédula ${inv.vendor_tax_id})` : ' y no trae cédula'}`);
  else {
    if (!inv.vendor_tax_id || inv.vendor_tax_id.length < 9 || inv.vendor_tax_id.length > 12) add('PROV_CEDULA', 'la cédula falta o no tiene un formato válido');
    const sim = similarity(nameKey(vendor.name), inv.vendor_name_key);
    if (sim < 0.5) add('PROV_NOMBRE', `la cédula corresponde a «${vendor.name}», pero el nombre facturado es «${inv.vendor_name}»`);
    if (inv.bank_account && vendor.bank_account && inv.bank_account !== vendor.bank_account) add('PROV_CUENTA_CAMBIO', 'la cuenta bancaria no coincide con la registrada en el maestro');
  }
  const emp = get('SELECT * FROM ap_employees WHERE national_id = ? OR name_key = ?', inv.vendor_tax_id || '', inv.vendor_name_key || '');
  if (emp) add('PROV_EMPLEADO', `coincide con el empleado ${emp.name} (cédula ${emp.national_id})`);
  return out;
}

export function weightMap() {
  const m = Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, r.weight]));
  for (const w of all('SELECT rule,weight FROM ap_risk_weights')) if (w.rule in m) m[w.rule] = w.weight;
  return m;
}

export function levelFor(score, S = getSettings()) {
  return score >= S.umbral_alto ? 'alto' : score >= S.umbral_medio ? 'medio' : 'bajo';
}

export function scoreInvoice(inv, S = getSettings(), W = weightMap()) {
  const findings = evaluateInvoice(inv, S, W);
  const score = Math.min(100, findings.reduce((s, f) => s + f.weight, 0));
  const level = levelFor(score, S);
  run('UPDATE ap_invoices SET risk_score=?, risk_level=?, findings=? WHERE id=?', score, level, JSON.stringify(findings), inv.id);
  return { score, level, findings };
}

export function rescoreAll() {
  const S = getSettings(); const W = weightMap();
  tx(() => { for (const inv of all('SELECT * FROM ap_invoices')) scoreInvoice(inv, S, W); });
}

export const requiredApprovals = (totalCrc, S = getSettings()) => (totalCrc > S.limite_aprobacion ? 2 : 1);

/** Permiso que se necesita para la siguiente aprobación (o rechazo) de una factura. */
export function nextApprovalPerm(inv) {
  return inv.approved_1_by ? 'ap.approve_high' : 'ap.approve';
}

/**
 * Registra una factura (correo, XML, PDF, importación o captura manual).
 * Limpia los datos, busca al proveedor en el maestro, calcula el riesgo y deja la bitácora.
 */
export function ingest(raw, { source, actor = null, ip = null, device = null, now = new Date(), inboxId = null, rawText = null, needsReview = false }) {
  const S = getSettings();
  const { rec, log, issues } = cleanRecord(raw);
  const fx = rec.currency === 'USD' ? S.tipo_cambio_usd : 1;
  const total_crc = Math.round((rec.total ?? 0) * fx * 100) / 100;
  if (rec.currency === 'USD') log.push({ field: 'Tipo de cambio', from: '', to: `${S.tipo_cambio_usd} CRC/USD` });
  const vendor = rec.tax_id ? get('SELECT * FROM ap_vendors WHERE tax_id=?', rec.tax_id) : null;
  const hash = crypto.createHash('sha256').update(JSON.stringify([rec.tax_id, rec.number_key, rec.issue_date, total_crc])).digest('hex');
  const hasCritical = issues.some((i) => i.critical);
  const id = tx(() => {
    const r = run(`INSERT INTO ap_invoices (invoice_number,number_key,vendor_id,vendor_tax_id,vendor_name,vendor_name_key,issue_date,currency,exchange_rate,
        subtotal,tax,total,total_crc,category,description,bank_account,source,status,required_approvals,cleaning_log,quality_issues,needs_human_review,
        inbox_id,raw_text,risk_score,risk_level,content_hash,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'en_revision',?,?,?,?,?,?,0,'bajo',?,?,?)`,
      rec.invoice_number, rec.number_key, vendor?.id ?? null, rec.tax_id, rec.vendor_name, rec.vendor_name_key, rec.issue_date ?? '',
      rec.currency, fx, rec.subtotal ?? 0, rec.tax ?? 0, rec.total ?? 0, total_crc, rec.category, rec.description, rec.bank_account,
      source, requiredApprovals(total_crc, S), JSON.stringify(log), JSON.stringify(issues),
      needsReview || hasCritical || source === 'pdf' ? 1 : 0, inboxId, rawText, hash, actor?.id ?? null, now.toISOString());
    return Number(r.lastInsertRowid);
  });
  const inv = get('SELECT * FROM ap_invoices WHERE id=?', id);
  const { level, score } = scoreInvoice(inv, S);
  logEvent({ user: actor, action: 'CXP_RECIBIDA', entity: 'factura_cxp', entityId: id, ip, device, ts: now.toISOString(),
    detail: `${rec.vendor_name} · ${rec.invoice_number || 's/n'} · ${crc(total_crc)} · origen ${source} · riesgo ${level} (${score})` });
  if (level === 'alto') {
    notify({ level: 'warning', title: `Factura de riesgo alto: ${rec.invoice_number || 'sin número'}`,
      body: `${rec.vendor_name || 'Proveedor sin nombre'} · ${crc(total_crc)}. Revisar antes de aprobar.`, link: `/cxp/facturas/${id}`, ts: now.toISOString() });
  }
  return get('SELECT * FROM ap_invoices WHERE id=?', id);
}

function loadInvoice(id) {
  const inv = get('SELECT * FROM ap_invoices WHERE id=?', id);
  if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
  return inv;
}

/** Primera o segunda aprobación. El permiso ya fue verificado por la ruta. */
export function approveInvoice(id, actor, { note = '', ip, device }) {
  return tx(() => {
    const inv = loadInvoice(id);
    if (!OPEN.some((s) => inv.status === s.replace(/'/g, ''))) throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${inv.status}`);
    if (inv.needs_human_review) throw new HttpError(409, 'REVISION_PENDIENTE', 'Corrige los datos y confirma la revisión antes de aprobar');
    const segregation = (msg) => {
      logEvent({ user: actor, action: 'SEGREGACION_BLOQUEADA', entity: 'factura_cxp', entityId: id, detail: msg, ip, device });
      throw new HttpError(403, 'SEGREGACION_FUNCIONES', msg);
    };
    if (inv.created_by === actor.id) segregation('No puedes aprobar una factura que tú mismo registraste');
    if (inv.approved_1_by === actor.id) segregation('El segundo nivel debe aprobarlo una persona distinta al primero');
    if (inv.risk_level === 'alto' && String(note).trim().length < 10) throw new HttpError(422, 'VALIDACION', 'Las facturas de riesgo alto requieren justificación (mínimo 10 caracteres)');
    const now = new Date().toISOString();
    const level = inv.approved_1_by ? 2 : 1;
    if (level === 1) {
      const status = inv.required_approvals >= 2 ? 'aprobada_parcial' : 'aprobada';
      run('UPDATE ap_invoices SET approved_1_by=?, approved_1_at=?, approval_note=?, status=? WHERE id=?', actor.id, now, note || null, status, id);
    } else {
      run("UPDATE ap_invoices SET approved_2_by=?, approved_2_at=?, approval_note=?, status='aprobada' WHERE id=?", actor.id, now, note || inv.approval_note, id);
    }
    logEvent({ user: actor, action: 'CXP_APROBACION', entity: 'factura_cxp', entityId: id, ip, device, ts: now,
      detail: `${inv.invoice_number} · ${crc(inv.total_crc)} · nivel ${level} de ${inv.required_approvals}${note ? ` · «${String(note).slice(0, 120)}»` : ''}` });
    return loadInvoice(id);
  });
}

export function rejectInvoice(id, actor, { reason, ip, device }) {
  const msg = String(reason ?? '').trim();
  if (msg.length < 5) throw new HttpError(422, 'VALIDACION', 'Indica el motivo del rechazo (mínimo 5 caracteres)');
  return tx(() => {
    const inv = loadInvoice(id);
    if (!OPEN.some((s) => inv.status === s.replace(/'/g, ''))) throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${inv.status}`);
    run("UPDATE ap_invoices SET status='rechazada', reject_reason=? WHERE id=?", msg, id);
    logEvent({ user: actor, action: 'CXP_RECHAZO', entity: 'factura_cxp', entityId: id, ip, device, detail: `${inv.invoice_number} rechazada: ${msg}` });
    return loadInvoice(id);
  });
}

const EDITABLE = ['invoice_number', 'issue_date', 'vendor_name', 'vendor_tax_id', 'currency', 'subtotal', 'tax', 'total', 'category', 'bank_account', 'description'];

/** Corrección manual: vuelve a limpiar los datos, recalcula riesgo y registra cada cambio. */
export function reviewInvoice(id, input, actor, { ip, device }) {
  return tx(() => {
    const inv = loadInvoice(id);
    if (!OPEN.some((s) => inv.status === s.replace(/'/g, ''))) throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${inv.status}`);
    const merged = {
      vendor_name: inv.vendor_name, tax_id: inv.vendor_tax_id, invoice_number: inv.invoice_number, issue_date: inv.issue_date,
      currency: inv.currency, subtotal: inv.subtotal, tax: inv.tax, total: inv.total, category: inv.category,
      bank_account: inv.bank_account, description: inv.description,
    };
    for (const k of EDITABLE) if (input[k] !== undefined) merged[k === 'vendor_tax_id' ? 'tax_id' : k === 'vendor_name' ? 'vendor_name' : k] = input[k];
    const { rec, log, issues } = cleanRecord(merged);
    const S = getSettings();
    const fx = rec.currency === 'USD' ? S.tipo_cambio_usd : 1;
    const total_crc = Math.round((rec.total ?? 0) * fx * 100) / 100;
    const vendor = rec.tax_id ? get('SELECT * FROM ap_vendors WHERE tax_id=?', rec.tax_id) : null;
    const prevLog = inv.cleaning_log ? JSON.parse(inv.cleaning_log) : [];
    const manual = Object.keys(input).filter((k) => EDITABLE.includes(k)).map((k) => ({ field: `Corrección manual · ${k}`, from: String(inv[k === 'vendor_tax_id' ? 'vendor_tax_id' : k] ?? ''), to: String(input[k]) }));
    const hasCritical = issues.some((i) => i.critical);
    const confirmed = input.confirm === true;
    if (confirmed && hasCritical) throw new HttpError(409, 'DATOS_INCOMPLETOS', 'Faltan datos mínimos: no se puede confirmar la revisión');
    const needs = hasCritical || (!confirmed && (inv.needs_human_review || inv.source === 'pdf')) ? 1 : 0;
    run(`UPDATE ap_invoices SET invoice_number=?, number_key=?, vendor_id=?, vendor_tax_id=?, vendor_name=?, vendor_name_key=?, issue_date=?, currency=?,
        exchange_rate=?, subtotal=?, tax=?, total=?, total_crc=?, category=?, bank_account=?, description=?, quality_issues=?, cleaning_log=?, needs_human_review=?
        WHERE id=?`,
      rec.invoice_number, rec.number_key, vendor?.id ?? null, rec.tax_id, rec.vendor_name, rec.vendor_name_key, rec.issue_date ?? '', rec.currency, fx,
      rec.subtotal ?? 0, rec.tax ?? 0, rec.total ?? 0, total_crc, rec.category, rec.bank_account, rec.description,
      JSON.stringify(issues), JSON.stringify([...prevLog, ...manual, ...log.filter((l) => !prevLog.some((p) => p.field === l.field && p.to === l.to))]), needs, id);
    const updated = get('SELECT * FROM ap_invoices WHERE id=?', id);
    scoreInvoice(updated, S);
    logEvent({ user: actor, action: 'CXP_REVISION', entity: 'factura_cxp', entityId: id, ip, device,
      detail: `${inv.invoice_number}: ${manual.length} corrección(es)${confirmed ? ' · datos confirmados' : ''}` });
    return loadInvoice(id);
  });
}

export function listInvoices({ status, risk, q, limit = 100, offset = 0 } = {}) {
  const where = []; const p = [];
  if (status === 'abiertas') where.push(`status IN ('en_revision','aprobada_parcial')`);
  else if (status) { where.push('status = ?'); p.push(status); }
  if (risk) { where.push('risk_level = ?'); p.push(risk); }
  if (q) { where.push('(vendor_name LIKE ? OR invoice_number LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(`SELECT id,invoice_number,vendor_name,vendor_tax_id,issue_date,currency,total,total_crc,category,source,status,risk_level,risk_score,
      needs_human_review,required_approvals,created_at FROM ap_invoices ${W} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, Math.min(limit, 500), offset);
  const total = get(`SELECT COUNT(*) n FROM ap_invoices ${W}`, ...p).n;
  return { invoices: rows, total };
}

export function getInvoice(id) {
  const inv = loadInvoice(id);
  const vendor = inv.vendor_id ? get('SELECT id,name,tax_id,bank_account,status FROM ap_vendors WHERE id=?', inv.vendor_id) : null;
  const creator = inv.created_by ? get('SELECT name,role FROM users WHERE id=?', inv.created_by) : null;
  const approvers = [inv.approved_1_by, inv.approved_2_by].filter(Boolean).map((uid) => get('SELECT id,name,role FROM users WHERE id=?', uid));
  const audit = all("SELECT ts,user_name,action,detail FROM audit_log WHERE entity = 'factura_cxp' AND entity_id = ? ORDER BY id DESC LIMIT 20", String(id));
  return {
    ...inv,
    findings: JSON.parse(inv.findings || '[]'),
    cleaning_log: JSON.parse(inv.cleaning_log || '[]'),
    quality_issues: JSON.parse(inv.quality_issues || '[]'),
    vendor, creator, approvers, audit,
    settings: getSettings(),
    approval_perm_needed: OPEN.some((s) => inv.status === s.replace(/'/g, '')) ? nextApprovalPerm(inv) : null,
  };
}

export function dashboard() {
  const S = getSettings();
  const all_ = all('SELECT id,vendor_name,invoice_number,issue_date,total_crc,category,status,risk_level,risk_score,needs_human_review,findings,source,created_at FROM ap_invoices');
  const open = all_.filter((i) => i.status === 'en_revision' || i.status === 'aprobada_parcial');
  const sum = (arr) => arr.reduce((s, i) => s + i.total_crc, 0);
  const byLevel = Object.fromEntries(['alto', 'medio', 'bajo'].map((l) => {
    const arr = open.filter((i) => i.risk_level === l); return [l, { count: arr.length, amount: sum(arr) }];
  }));
  const byStatus = Object.fromEntries(['en_revision', 'aprobada_parcial', 'aprobada', 'rechazada'].map((s) => [s, all_.filter((i) => i.status === s).length]));
  const ruleCount = {};
  for (const i of open) for (const f of JSON.parse(i.findings || '[]')) {
    ruleCount[f.rule] ??= { rule: f.rule, label: f.label, count: 0, weight: f.weight };
    ruleCount[f.rule].count++;
  }
  const byCategory = CATEGORY_LIST().map((c) => ({ category: c, amount: sum(open.filter((i) => i.category === c)), count: open.filter((i) => i.category === c).length }));
  const weekStart = (d) => { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); };
  const trend = new Map();
  const nowIso = new Date().toISOString();
  const thisWeek = weekStart(localParts(nowIso).date);
  for (let w = 7; w >= 0; w--) trend.set(new Date(Date.parse(`${thisWeek}T00:00:00Z`) - w * 7 * 86400e3).toISOString().slice(0, 10), { week: '', count: 0, amount: 0 });
  for (const i of all_) {
    if (!i.issue_date) continue;
    const k = weekStart(i.issue_date); if (trend.has(k)) { const t = trend.get(k); t.count++; t.amount += i.total_crc; }
  }
  const automatic = all_.filter((i) => i.source === 'xml' && !i.needs_human_review).length;
  return {
    settings: S,
    kpis: {
      facturas: all_.length,
      abiertas: open.length,
      monto_abierto: sum(open),
      alto_abiertas: byLevel.alto.count,
      revision_pendiente: all_.filter((i) => i.needs_human_review).length,
      aprobadas: byStatus.aprobada,
      automatizadas_pct: all_.length ? Math.round((automatic / all_.length) * 100) : 0,
    },
    by_level: byLevel,
    by_status: byStatus,
    by_category: byCategory,
    top_rules: Object.values(ruleCount).sort((a, b) => b.count - a.count).slice(0, 8),
    critical: open.filter((i) => i.risk_level === 'alto').sort((a, b) => b.risk_score - a.risk_score || b.id - a.id).slice(0, 10)
      .map((i) => ({ id: i.id, vendor_name: i.vendor_name, invoice_number: i.invoice_number, total_crc: i.total_crc, risk_score: i.risk_score, status: i.status, findings: JSON.parse(i.findings || '[]').slice(0, 3) })),
    trend: [...trend].map(([k, v]) => ({ ...v, week: k })),
    inbox: all('SELECT id,direction,counterpart,subject,scenario,outcome,received_at FROM ap_inbox ORDER BY id DESC LIMIT 8'),
  };
}

export const CATEGORY_LIST = () => ['Gastos operativos', 'Compras de inventario', 'Pagos a proveedores', 'Activos fijos'];
export { HttpError };
