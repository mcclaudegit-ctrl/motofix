import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motofix-cxp-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.DATA_DIR = dir;
process.env.DEMO_MODE = 'true';
delete process.env.AI_API_KEY;

const { createApp, resetRateLimits } = await import('../src/lib/http.js');
const { buildRouter } = await import('../src/routes/index.js');
const { seed } = await import('../src/seed.js');
const { cleanRecord, parseAmount, parseDate, nameKey, numberKey, cleanName } = await import('../src/services/ap-clean.js');
const { DatabaseSync } = await import('node:sqlite');

let server; let base; const tokens = {};
before(async () => {
  await seed();
  server = createApp(buildRouter());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const k of ['admin', 'gerente', 'contador', 'auditor', 'recepcionista']) {
    tokens[k] = (await call('POST', '/api/auth/demo-login', null, { key: k })).body.token;
  }
});
after(() => server.close());

async function call(method, url, token, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function raw(url, token, buf, contentType = 'application/octet-stream') {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` }, body: buf });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
const manual = (over = {}) => ({ vendor_name: 'Repuestos del Pacífico S.A.', tax_id: '3-101-884211', invoice_number: `T-${Math.random().toString(36).slice(2, 8)}`,
  issue_date: '2026-11-10', currency: 'CRC', total: 150000, category: 'Compras de inventario', ...over });

test('limpieza: montos, fechas, nombres y números', () => {
  assert.equal(parseAmount('₡1.250.000,00'), 1250000);
  assert.equal(parseAmount('$1,250.50'), 1250.5);
  assert.equal(parseDate('03/11/2026'), '2026-11-03');
  assert.equal(parseDate('2026-02-31'), null);
  assert.equal(cleanName('repuestos del PACIFICO s.a.'), 'repuestos del PACIFICO S.A.');
  assert.equal(nameKey('Repuestos del Pacífico S.A.'), nameKey('REPUESTOS DEL PACIFICO SA'));
  assert.equal(numberKey('FE-000123'), numberKey('FE-123'));
  const { rec, log, issues } = cleanRecord({ vendor_name: 'x', tax_id: '3-101-884211', invoice_number: 'A1', issue_date: '01/12/2026', total: '₡ 500.000,00', currency: 'colones' });
  assert.equal(rec.tax_id, '3101884211');
  assert.equal(rec.total, 500000);
  assert.equal(rec.subtotal + rec.tax, 500000, 'IVA calculado desde el total');
  assert.ok(log.some((l) => l.field === 'Fecha' && l.to === '2026-12-01'));
  assert.equal(issues.filter((i) => i.critical).length, 0);
  const bad = cleanRecord({ vendor_name: '', total: '' });
  assert.ok(bad.issues.some((i) => i.critical && i.field === 'Total'));
});

test('motor de riesgo: duplicado por número y factura por dos canales', async () => {
  const seeded = await call('GET', '/api/ap/invoices?q=FE-REP-2201', tokens.contador);
  assert.equal(seeded.body.invoices.length, 2);
  const dup = seeded.body.invoices.find((i) => i.source === 'xml');
  const detail = await call('GET', `/api/ap/invoices/${dup.id}`, tokens.contador);
  assert.ok(detail.body.findings.some((f) => f.rule === 'DUP_DOBLE_CANAL' || f.rule === 'DUP_NUMERO'));
  assert.equal(detail.body.risk_level, 'alto');
});

test('fraccionamiento y monto atípico quedan marcados en el dashboard', async () => {
  const d = await call('GET', '/api/ap/dashboard', tokens.gerente);
  assert.equal(d.status, 200);
  assert.ok(d.body.top_rules.some((r) => r.rule === 'PAT_FRACCIONAMIENTO'));
  assert.ok(d.body.top_rules.some((r) => r.rule === 'PAT_ATIPICO'));
  assert.ok(d.body.critical.length > 0);
  assert.ok(d.body.by_level.alto.count >= 1);
});

test('el contador no puede aprobar la factura que él registró (segregación)', async () => {
  const created = await call('POST', '/api/ap/invoices', tokens.contador, manual());
  assert.equal(created.status, 200);
  const id = created.body.invoice.id;
  const self = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.contador, { note: '' });
  assert.equal(self.status, 403);
  assert.equal(self.body.error, 'SEGREGACION_FUNCIONES');
});

test('segundo nivel sobre ₡700.000: gerente aprueba y el mismo gerente no puede completar', async () => {
  const created = await call('POST', '/api/ap/invoices', tokens.contador, manual({ total: 900000 }));
  const id = created.body.invoice.id;
  assert.equal(created.body.invoice.required_approvals, 2);
  const first = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.gerente, { note: 'Compra aprobada por orden' });
  assert.equal(first.status, 200);
  assert.equal(first.body.invoice.status, 'aprobada_parcial');
  const again = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.gerente, { note: 'otra vez' });
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'SEGREGACION_FUNCIONES', 'el gerente aprobó el primer nivel: no puede firmar también el segundo');
  const second = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.admin, { note: 'Segundo nivel: sobre el límite' });
  assert.equal(second.status, 200);
  assert.equal(second.body.invoice.status, 'aprobada');
});

test('factura con datos mínimos incompletos no se puede aprobar hasta corregirla', async () => {
  const created = await call('POST', '/api/ap/invoices', tokens.contador, manual({ invoice_number: '' }));
  assert.equal(created.status, 200);
  const id = created.body.invoice.id;
  assert.equal(created.body.invoice.needs_human_review, 1);
  const blocked = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.gerente, { note: '' });
  assert.equal(blocked.status, 409);
  const fixed = await call('PATCH', `/api/ap/invoices/${id}`, tokens.contador, { invoice_number: 'FE-CORREGIDA-1', confirm: true });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.invoice.needs_human_review, 0);
  assert.ok(fixed.body.invoice.cleaning_log.some((l) => l.field.startsWith('Corrección manual')));
  const ok = await call('POST', `/api/ap/invoices/${id}/approve`, tokens.gerente, { note: '' });
  assert.equal(ok.status, 200);
});

test('bandeja simulada: cumple, parcial y no cumple con su respuesta correspondiente', async () => {
  const cumple = await call('POST', '/api/ap/inbox/simulate', tokens.contador, { scenario: 'cumple' });
  assert.equal(cumple.status, 200);
  assert.match(cumple.body.outcome, /Procesada automáticamente/);
  assert.equal(cumple.body.invoice.source, 'xml');
  const parcial = await call('POST', '/api/ap/inbox/simulate', tokens.contador, { scenario: 'parcial' });
  assert.equal(parcial.body.invoice.needs_human_review, 1);
  assert.match(parcial.body.outcome, /revisión humana/);
  const no = await call('POST', '/api/ap/inbox/simulate', tokens.contador, { scenario: 'no_cumple' });
  assert.match(no.body.outcome, /Incompleta|reenviar|Solicitamos/);
  const bad = await call('POST', '/api/ap/inbox/simulate', tokens.contador, { scenario: 'otro' });
  assert.equal(bad.status, 422);
  const aud = await call('POST', '/api/ap/inbox/simulate', tokens.auditor, { scenario: 'cumple' });
  assert.equal(aud.status, 403, 'el auditor no recibe facturas');
});

test('PDF sin proveedor de IA configurado se rechaza con mensaje claro', async () => {
  const r = await raw('/api/ap/invoices/pdf', tokens.contador, Buffer.from('%PDF-1.4 test'));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'EXTRACCION_NO_DISPONIBLE');
  const notPdf = await raw('/api/ap/invoices/pdf', tokens.contador, Buffer.from('hola'));
  assert.equal(notPdf.body.error, 'FORMATO_INVALIDO');
});

test('importación de base SQLite externa en solo lectura, con mapeo validado', async () => {
  const f = path.join(dir, 'externa.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE cuentas (proveedor TEXT, factura TEXT, fecha TEXT, monto REAL, cedula TEXT);
           INSERT INTO cuentas VALUES ('Lubricantes Altura','EXT-1','2026-11-05',75000,'3101771903'),
                                      ('Papelería Central','EXT-2','05/11/2026','₡ 33.000,00','3101332201'),
                                      ('Proveedor Nuevo','EXT-3','2026-11-06',10000,'');`);
  db.close();
  const up = await raw('/api/ap/import/inspect?name=externa.db', tokens.recepcionista, fs.readFileSync(f));
  assert.equal(up.status, 403, 'la recepcionista no puede importar bases externas');
  const admin = await raw('/api/ap/import/inspect?name=externa.db', tokens.admin, fs.readFileSync(f));
  assert.equal(admin.status, 200);
  assert.equal(admin.body.kind, 'sqlite');
  const t = admin.body.tables.find((x) => x.name === 'cuentas');
  assert.equal(t.rows, 3);
  const mapping = { vendor_name: 'proveedor', invoice_number: 'factura', issue_date: 'fecha', total: 'monto', tax_id: 'cedula' };
  const bad = await call('POST', '/api/ap/import/run', tokens.admin, { token: admin.body.token, table: 'cuentas', mapping: { ...mapping, total: 'monto; DROP TABLE users' } });
  assert.equal(bad.status, 422);
  const missing = await call('POST', '/api/ap/import/run', tokens.admin, { token: admin.body.token, table: 'cuentas', mapping: { vendor_name: 'proveedor' } });
  assert.equal(missing.status, 422);
  const run = await call('POST', '/api/ap/import/run', tokens.admin, { token: admin.body.token, table: 'cuentas', mapping });
  assert.equal(run.status, 200);
  assert.equal(run.body.created, 3);
  assert.equal(run.body.rows_read, 3);
  const reuse = await call('POST', '/api/ap/import/run', tokens.admin, { token: admin.body.token, table: 'cuentas', mapping });
  assert.equal(reuse.status, 410, 'el token de importación es de un solo uso');
  const garbage = await raw('/api/ap/import/inspect?name=x.db', tokens.admin, Buffer.from('SQLite format 3\0basura'));
  assert.equal(garbage.body.error, 'SQLITE_INVALIDO');
  const dbNow = new DatabaseSync(f); dbNow.exec("CREATE TABLE t2 (x TEXT)"); dbNow.close();
  assert.ok(fs.existsSync(f));
});

test('importación CSV con la misma limpieza y motor de riesgo', async () => {
  const csv = 'Proveedor;Factura;Fecha;Total;Moneda\nRepuestos del Pacífico S.A.;CSV-7;2026-11-07;"₡ 120.000,00";colones\n';
  const up = await raw('/api/ap/import/inspect?name=carga.csv', tokens.admin, Buffer.from(csv, 'utf8'), 'text/csv');
  assert.equal(up.body.kind, 'csv');
  const run = await call('POST', '/api/ap/import/run', tokens.admin, { token: up.body.token, mapping: { vendor_name: 'Proveedor', invoice_number: 'Factura', issue_date: 'Fecha', total: 'Total', currency: 'Moneda' } });
  assert.equal(run.body.created, 1, JSON.stringify(run.body.errors));
});

test('reportes: PDF válido, Excel y CSV con BOM', async () => {
  const pdf = await call('POST', '/api/ap/reports', tokens.auditor, { kind: 'riesgo', format: 'pdf' });
  assert.equal(pdf.status, 200);
  const dl = await fetch(`${base}/api/ap/reports/${pdf.body.report.id}/download`, { headers: { Authorization: `Bearer ${tokens.auditor}` } });
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.toString('latin1').includes('%%EOF'));
  const xls = await call('POST', '/api/ap/reports', tokens.gerente, { kind: 'hallazgos', format: 'xls' });
  assert.equal(xls.status, 200);
  const dx = await fetch(`${base}/api/ap/reports/${xls.body.report.id}/download`, { headers: { Authorization: `Bearer ${tokens.gerente}` } });
  assert.match(await dx.text(), /urn:schemas-microsoft-com:office:spreadsheet/);
  const csv = await call('POST', '/api/ap/reports', tokens.gerente, { kind: 'pendientes', format: 'csv' });
  const dc = await fetch(`${base}/api/ap/reports/${csv.body.report.id}/download`, { headers: { Authorization: `Bearer ${tokens.gerente}` } });
  const cb = Buffer.from(await dc.arrayBuffer());
  assert.equal(cb[0], 0xef); assert.equal(cb[1], 0xbb); assert.equal(cb[2], 0xbf);
  const forbidden = await call('POST', '/api/ap/reports', tokens.recepcionista, { kind: 'riesgo', format: 'pdf' });
  assert.equal(forbidden.status, 403);
});

test('configuración: límite y pesos editables solo por quien tiene ap.settings', async () => {
  const denied = await call('PUT', '/api/ap/risk-weights', tokens.contador, { weights: { PAT_UMBRAL: 90 } });
  assert.equal(denied.status, 403);
  const bad = await call('PUT', '/api/ap/risk-weights', tokens.gerente, { weights: { PAT_UMBRAL: 500 } });
  assert.equal(bad.status, 422);
  const ok = await call('PUT', '/api/ap/risk-weights', tokens.gerente, { weights: { PAT_UMBRAL: 20 } });
  assert.equal(ok.body.weights.find((w) => w.rule === 'PAT_UMBRAL').weight, 20);
  const lim = await call('PUT', '/api/ap/settings', tokens.gerente, { limite_aprobacion: 700000, tipo_cambio_usd: 515 });
  assert.equal(lim.body.settings.tipo_cambio_usd, 515);
});

test('el auditor revisa todo pero no aprueba ni modifica', async () => {
  assert.equal((await call('GET', '/api/ap/dashboard', tokens.auditor)).status, 200);
  const list = await call('GET', '/api/ap/invoices', tokens.auditor);
  const id = list.body.invoices[0].id;
  assert.equal((await call('POST', `/api/ap/invoices/${id}/approve`, tokens.auditor, { note: '' })).status, 403);
  assert.equal((await call('PATCH', `/api/ap/invoices/${id}`, tokens.auditor, { total: 1 })).status, 403);
  assert.equal((await call('GET', '/api/ap/invoices', tokens.recepcionista)).status, 403);
});
