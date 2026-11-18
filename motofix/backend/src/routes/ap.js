import { all, get, run } from '../db.js';
import { Raw, HttpError } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { auth, perm, can, denyAccess } from '../auth.js';
import { PERMISSIONS } from '../permissions.js';
import {
  ingest, approveInvoice, rejectInvoice, reviewInvoice, listInvoices, getInvoice, dashboard,
  getSettings, saveSettings, getWeights, saveWeights, rescoreAll, nextApprovalPerm, RULES,
} from '../services/ap.js';
import { simulateInbox, SCENARIOS } from '../services/ap-inbox.js';
import { inspectUpload, runImport, receiveChunk, FIELDS, MAX_IMPORT_BYTES, MAX_REQUEST_BYTES } from '../services/ap-import.js';
import { generateReport, listReports, getReport, REPORT_KINDS } from '../services/ap-report.js';
import { extractFromPdf, extractorInfo } from '../services/ai-extractor.js';
import { cleanTaxId, cleanName } from '../services/ap-clean.js';
import { logEvent } from '../audit.js';
import { demoCatalog, demoTemplate } from '../services/ap-demo.js';

// Permiso de aprobación según el nivel que corresponde a la factura.
const approvalGuard = (ctx, inv) => {
  const p = nextApprovalPerm(inv);
  if (!can(ctx, p)) denyAccess(ctx, p, p === 'ap.approve_high' ? 'Aprobar facturas sobre el límite (segundo nivel)' : 'Aprobar facturas');
};
const meta = (ctx) => ({ actor: ctx.user, ip: ctx.ip, device: ctx.device });
const evt = (ctx) => ({ user: ctx.user, ip: ctx.ip, device: ctx.device });

export function apRoutes(r) {
  r.get('/api/ap/dashboard', auth, perm('ap.view'), () => dashboard());

  r.get('/api/ap/invoices', auth, perm('ap.view'), (ctx) => listInvoices({
    status: ctx.query.status, risk: ctx.query.risk, q: ctx.query.q,
    limit: Number(ctx.query.limit) || 100, offset: Number(ctx.query.offset) || 0,
  }));

  r.get('/api/ap/invoices/:id', auth, perm('ap.view'), (ctx) => getInvoice(Number(ctx.params.id)));

  // Plantillas de demostración para «Registrar factura» (riesgo bajo, medio y alto)
  r.get('/api/ap/demo-templates', auth, perm('ap.simulate'), () => demoCatalog());
  r.get('/api/ap/demo-templates/:id', auth, perm('ap.simulate'), (ctx) => {
    const t = demoTemplate(ctx.params.id);
    if (!t) throw new HttpError(404, 'NO_ENCONTRADO', 'Plantilla no encontrada');
    return t;
  });

  // Entrada manual (módulo 1): captura con limpieza automática
  r.post('/api/ap/invoices', auth, perm('ap.simulate'), (ctx) => {
    const b = ctx.body;
    const inv = ingest({
      vendor_name: v.str(b.vendor_name, 'proveedor', { max: 120 }), tax_id: b.tax_id, invoice_number: b.invoice_number,
      issue_date: b.issue_date, currency: b.currency, subtotal: b.subtotal, tax: b.tax, total: v.num(b.total, 'total', { min: 0.01, max: 1e10 }),
      category: b.category, bank_account: b.bank_account, description: b.description,
    }, { source: 'manual', ...meta(ctx) });
    return { invoice: getInvoice(inv.id) };
  });

  // Lectura de PDF (módulo 1, vía proveedor de IA configurado). Siempre requiere revisión humana.
  r.postRaw('/api/ap/invoices/pdf', auth, perm('ap.simulate'), async (ctx) => {
    const buf = ctx.rawBody;
    if (!buf?.length) throw new HttpError(422, 'ARCHIVO_VACIO', 'Envía el PDF en el cuerpo de la solicitud');
    if (buf.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'PAYLOAD_GRANDE', `El PDF supera ${MAX_REQUEST_BYTES / 1024 / 1024} MB`);
    if (buf.subarray(0, 4).toString('latin1') !== '%PDF') throw new HttpError(422, 'FORMATO_INVALIDO', 'El archivo no es un PDF');
    const ex = await extractFromPdf({ base64Pdf: buf.toString('base64') });
    const f = ex.fields || {};
    const inv = ingest({
      vendor_name: f.vendor_name, tax_id: f.tax_id, invoice_number: f.invoice_number, issue_date: f.issue_date, currency: f.currency,
      subtotal: f.subtotal, tax: f.tax, total: f.total, category: f.category, bank_account: f.bank_account,
    }, { source: 'pdf', needsReview: true, rawText: `PDF ${ctx.query.name || 'sin nombre'} · extractor ${ex.provider}${ex.model ? ` (${ex.model})` : ''}`, ...meta(ctx) });
    return { invoice: getInvoice(inv.id), extractor: ex.provider };
  });

  r.patch('/api/ap/invoices/:id', auth, perm('ap.review'), (ctx) => {
    const id = Number(ctx.params.id);
    return { invoice: getInvoice(reviewInvoice(id, ctx.body || {}, ctx.user, meta(ctx)).id) };
  });

  r.post('/api/ap/invoices/:id/approve', auth, (ctx) => {
    const inv = get('SELECT * FROM ap_invoices WHERE id=?', Number(ctx.params.id));
    if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
    approvalGuard(ctx, inv);
    const out = approveInvoice(inv.id, ctx.user, { note: ctx.body.note || '', ...meta(ctx) });
    return { invoice: getInvoice(out.id) };
  });

  r.post('/api/ap/invoices/:id/reject', auth, (ctx) => {
    const inv = get('SELECT * FROM ap_invoices WHERE id=?', Number(ctx.params.id));
    if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
    approvalGuard(ctx, inv);
    const out = rejectInvoice(inv.id, ctx.user, { reason: ctx.body.reason, ...meta(ctx) });
    return { invoice: getInvoice(out.id) };
  });

  // Bandeja simulada
  r.get('/api/ap/inbox', auth, perm('ap.view'), () => ({
    messages: all('SELECT * FROM ap_inbox ORDER BY id DESC LIMIT 50'), scenarios: SCENARIOS,
  }));
  r.post('/api/ap/inbox/simulate', auth, perm('ap.simulate'), async (ctx) => {
    const scenario = v.oneOf(ctx.body.scenario, 'escenario', Object.keys(SCENARIOS));
    return simulateInbox(scenario, ctx.user, meta(ctx));
  });

  // Maestro de proveedores y empleados
  r.get('/api/ap/vendors', auth, perm('ap.vendors.view'), () => ({
    vendors: all(`SELECT vv.*, (SELECT COUNT(*) FROM ap_invoices i WHERE i.vendor_id = vv.id) invoices,
      (SELECT COALESCE(SUM(total_crc),0) FROM ap_invoices i WHERE i.vendor_id = vv.id AND i.status NOT IN ('rechazada')) amount
      FROM ap_vendors vv ORDER BY name`),
  }));
  r.post('/api/ap/vendors', auth, perm('ap.vendors.manage'), (ctx) => {
    const name = cleanName(v.str(ctx.body.name, 'nombre', { max: 120 }));
    const tax = cleanTaxId(v.str(ctx.body.tax_id, 'cédula', { max: 20 }));
    if (!tax || tax.length < 9 || tax.length > 12) throw new HttpError(422, 'VALIDACION', 'cédula: entre 9 y 12 dígitos');
    if (get('SELECT id FROM ap_vendors WHERE tax_id=?', tax)) throw new HttpError(409, 'DUPLICADO', 'Ya existe un proveedor con esa cédula');
    const now = new Date().toISOString();
    const key = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const res = run('INSERT INTO ap_vendors (tax_id,name,name_key,category,bank_account,contact_email,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      tax, name, key, v.oneOf(ctx.body.category || 'Gastos operativos', 'categoría', ['Gastos operativos', 'Compras de inventario', 'Pagos a proveedores', 'Activos fijos']),
      ctx.body.bank_account ? String(ctx.body.bank_account).replace(/\s+/g, '').toUpperCase() : null, ctx.body.contact_email || null, 'activo', now);
    logEvent({ ...evt(ctx), action: 'CXP_PROVEEDOR_ALTA', entity: 'proveedor_cxp', entityId: Number(res.lastInsertRowid), detail: `${name} · cédula ${tax}` });
    return { vendor: get('SELECT * FROM ap_vendors WHERE id=?', Number(res.lastInsertRowid)) };
  });
  r.patch('/api/ap/vendors/:id', auth, perm('ap.vendors.manage'), (ctx) => {
    const id = Number(ctx.params.id);
    const cur = get('SELECT * FROM ap_vendors WHERE id=?', id);
    if (!cur) throw new HttpError(404, 'NO_ENCONTRADO', 'Proveedor no encontrado');
    const b = ctx.body || {};
    const bank = b.bank_account !== undefined ? (b.bank_account ? String(b.bank_account).replace(/\s+/g, '').toUpperCase() : null) : cur.bank_account;
    const status = b.status !== undefined ? v.oneOf(b.status, 'estado', ['activo', 'inactivo']) : cur.status;
    const name = b.name !== undefined ? cleanName(v.str(b.name, 'nombre', { max: 120 })) : cur.name;
    const changedBank = bank !== cur.bank_account;
    const now = new Date().toISOString();
    run('UPDATE ap_vendors SET name=?, name_key=?, bank_account=?, bank_account_changed_at=?, status=?, contact_email=? WHERE id=?',
      name, name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(), bank,
      changedBank ? now : cur.bank_account_changed_at, status, b.contact_email !== undefined ? b.contact_email : cur.contact_email, id);
    if (changedBank) logEvent({ ...evt(ctx), action: 'CAMBIO_CUENTA_PROVEEDOR', entity: 'proveedor_cxp', entityId: id, detail: `${cur.name}: cuenta ${cur.bank_account || '—'} → ${bank || '—'}` });
    rescoreAll();
    return { vendor: get('SELECT * FROM ap_vendors WHERE id=?', id) };
  });
  r.get('/api/ap/employees', auth, perm('ap.vendors.view'), () => ({ employees: all('SELECT id,national_id,name,active FROM ap_employees ORDER BY name') }));

  // Importación de bases externas (SQLite o CSV) — solo lectura
  r.postRaw('/api/ap/import/inspect', auth, perm('ap.import'), (ctx) => {
    const name = String(ctx.query.name || 'archivo').slice(0, 120);
    const out = inspectUpload(ctx.rawBody, name);
    logEvent({ ...evt(ctx), action: 'CXP_IMPORTACION_CARGA', entity: 'importacion', detail: `${name} (${out.kind})` });
    return { ...out, fields: FIELDS, limits: { max_mb: MAX_IMPORT_BYTES / 1024 / 1024 } };
  });
  r.postRaw('/api/ap/import/chunk', auth, perm('ap.import'), (ctx) => {
    const name = String(ctx.query.name || 'archivo').slice(0, 120);
    const out = receiveChunk({ uploadId: ctx.query.upload, part: ctx.query.part, total: ctx.query.total, name, body: ctx.rawBody, userId: ctx.user.id });
    if (!out.done) return out;
    logEvent({ ...evt(ctx), action: 'CXP_IMPORTACION_CARGA', entity: 'importacion', detail: `${name} (${out.kind}, por partes)` });
    return { ...out, fields: FIELDS, limits: { max_mb: MAX_IMPORT_BYTES / 1024 / 1024 } };
  });
  r.post('/api/ap/import/run', auth, perm('ap.import'), (ctx) => runImport(ctx.body, ctx.user, meta(ctx)));

  // Reportes automáticos
  r.get('/api/ap/reports', auth, perm('ap.reports'), () => ({ reports: listReports(), kinds: REPORT_KINDS }));
  r.post('/api/ap/reports', auth, perm('ap.reports'), (ctx) => {
    const kind = v.oneOf(ctx.body.kind, 'tipo', Object.keys(REPORT_KINDS));
    const format = v.oneOf(ctx.body.format, 'formato', ['pdf', 'xlsx', 'xls', 'csv']);
    return { report: generateReport({ kind, format, actor: ctx.user }) };
  });
  r.get('/api/ap/reports/:id/download', auth, perm('ap.reports'), (ctx) => {
    const f = getReport(Number(ctx.params.id));
    logEvent({ ...evt(ctx), action: 'CXP_REPORTE_DESCARGA', entity: 'reporte_cxp', entityId: Number(ctx.params.id), detail: f.filename });
    return new Raw(f.body, f.mime, { 'Content-Disposition': `attachment; filename="${f.filename}"` });
  });

  // Configuración
  r.get('/api/ap/settings', auth, perm('ap.view'), () => ({
    settings: getSettings(), weights: getWeights(), rules: Object.fromEntries(Object.entries(RULES).map(([k, x]) => [k, x.label])),
    provider: extractorInfo(),
  }));
  r.put('/api/ap/settings', auth, perm('ap.settings'), (ctx) => ({ settings: saveSettings(ctx.body || {}, ctx.user, meta(ctx)) }));
  r.put('/api/ap/risk-weights', auth, perm('ap.settings'), (ctx) => ({ weights: saveWeights(ctx.body?.weights || {}, ctx.user, meta(ctx)) }));
}
