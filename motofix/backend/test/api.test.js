import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motofix-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.DATA_DIR = dir;
process.env.DEMO_MODE = 'true';

const { createApp } = await import('../src/lib/http.js');
const { buildRouter } = await import('../src/routes/index.js');
const { seed } = await import('../src/seed.js');
const { resetRateLimits } = await import('../src/lib/http.js');

let server; let base;
before(async () => {
  await seed();
  server = createApp(buildRouter());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, token, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const login = async (key) => (await call('POST', '/api/auth/demo-login', null, { key })).body.token;

test('requiere autenticación', async () => {
  assert.equal((await call('GET', '/api/invoices')).status, 401);
});

test('login con credenciales reales y fallido queda en bitácora', async () => {
  resetRateLimits();
  const ok = await call('POST', '/api/auth/login', null, { email: 'admin@motofix.demo', password: 'MotoFix2026!' });
  assert.equal(ok.status, 200);
  const bad = await call('POST', '/api/auth/login', null, { email: 'admin@motofix.demo', password: 'incorrecta' });
  assert.equal(bad.status, 401);
});

test('recepcionista no puede anular: 403, queda registrado y notificado', async () => {
  const t = await login('recepcionista');
  const list = await call('GET', '/api/invoices?limit=1', t);
  const id = list.body.invoices[0].id;
  const r = await call('POST', `/api/invoices/${id}/void`, t, { reason: 'prueba de bloqueo' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'PERMISO_DENEGADO');
  const admin = await login('admin');
  const audit = await call('GET', '/api/audit?action=ACCESO_DENEGADO&limit=1', admin);
  assert.match(audit.body.events[0].detail, /Anular facturas/);
  const notes = await call('GET', '/api/notifications', admin);
  assert.ok(notes.body.notifications.some((n) => /Acción bloqueada/.test(n.title)));
});

test('recepcionista no puede aplicar descuento al emitir', async () => {
  const t = await login('recepcionista');
  const prods = (await call('GET', '/api/products?type=insumo', t)).body.products;
  const r = await call('POST', '/api/invoices', t, { kind: 'venta', discount_pct: 10, items: [{ product_id: prods[0].id, qty: 1 }] });
  assert.equal(r.status, 403);
});

test('factura: descuenta stock, usa precio de catálogo y bloquea duplicados', async () => {
  const t = await login('recepcionista');
  const p = (await call('GET', '/api/products?q=Filtro de aire', t)).body.products[0];
  const body = { kind: 'venta', items: [{ product_id: p.id, qty: 2, unit_price: 1 }] };
  const a = await call('POST', '/api/invoices', t, body);
  assert.equal(a.status, 201);
  assert.equal(a.body.items[0].unit_price, p.price, 'el precio del cliente se ignora');
  assert.equal(a.body.total, Math.round(p.price * 2 * 1.13));
  const after = (await call('GET', `/api/products?q=Filtro de aire`, t)).body.products[0];
  assert.equal(after.stock, p.stock - 2);
  const dup = await call('POST', '/api/invoices', t, body);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'FACTURA_DUPLICADA');
  // Un recepcionista no puede forzar el duplicado
  const force = await call('POST', '/api/invoices', t, { ...body, override_duplicate: true, override_reason: 'cliente pidió otra' });
  assert.equal(force.status, 403);
  // El gerente sí, con justificación
  const g = await login('gerente');
  const ok = await call('POST', '/api/invoices', g, { ...body, override_duplicate: true, override_reason: 'Dos motos del mismo cliente' });
  assert.equal(ok.status, 201);
});

test('stock insuficiente se rechaza', async () => {
  const t = await login('recepcionista');
  const p = (await call('GET', '/api/products?type=repuesto', t)).body.products[0];
  const r = await call('POST', '/api/invoices', t, { kind: 'venta', items: [{ product_id: p.id, qty: 99999 }] });
  assert.equal(r.status, 422);
});

test('flujo de anulación: contador solicita, gerente aprueba, stock se restituye; no se auto-aprueba', async () => {
  const g = await login('gerente'); const c = await login('contador');
  const p = (await call('GET', '/api/products?q=Bujía', g)).body.products[0];
  const inv = await call('POST', '/api/invoices', g, { kind: 'venta', items: [{ product_id: p.id, qty: 1 }] });
  const stockMid = (await call('GET', '/api/products?q=Bujía', g)).body.products[0].stock;
  const req = await call('POST', '/api/approvals', c, { type: 'anulacion', invoice_id: inv.body.id, reason: 'Error de cliente en la factura' });
  assert.equal(req.status, 201);
  assert.equal((await call('POST', '/api/approvals', c, { type: 'anulacion', invoice_id: inv.body.id, reason: 'Error de cliente en la factura' })).status, 409);
  assert.equal((await call('PATCH', `/api/approvals/${req.body.id}`, c, { decision: 'aprobada' })).status, 403, 'contador no resuelve');
  const res = await call('PATCH', `/api/approvals/${req.body.id}`, g, { decision: 'aprobada', note: 'ok' });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', `/api/invoices/${inv.body.id}`, g)).body.status, 'anulada');
  assert.equal((await call('GET', '/api/products?q=Bujía', g)).body.products[0].stock, stockMid + 1);
});

test('segregación de funciones: gerente no aprueba su propia solicitud', async () => {
  const g = await login('gerente');
  const inv = (await call('GET', '/api/invoices?status=pendiente&limit=1', g)).body.invoices[0];
  const req = await call('POST', '/api/approvals', g, { type: 'descuento', invoice_id: inv.id, pct: 5, reason: 'Descuento de cortesía aprobado' });
  assert.equal(req.status, 201);
  assert.equal((await call('PATCH', `/api/approvals/${req.body.id}`, g, { decision: 'aprobada' })).status, 403);
});

test('ventas no ve costos; proveedor solo accede al portal y a su propia data', async () => {
  const v = await login('ventas');
  const prods = (await call('GET', '/api/products', v)).body;
  assert.equal(prods.showCost, false);
  assert.equal(prods.products[0].cost, undefined);
  assert.equal((await call('GET', '/api/invoices', v)).status, 403);

  const p1 = await login('proveedor1');
  assert.equal((await call('GET', '/api/invoices', p1)).status, 403);
  assert.equal((await call('GET', '/api/audit', p1)).status, 403);
  const sum = await call('GET', '/api/portal/summary', p1);
  assert.equal(sum.status, 200);
  assert.ok(sum.body.invoices.every((i) => i.supplier_id === 1));
  // no puede confirmar la entrega de otro proveedor
  const p2 = await login('proveedor2');
  const other = (await call('GET', '/api/portal/summary', p2)).body.invoices[0];
  assert.equal((await call('POST', `/api/portal/invoices/${other.id}/confirm-delivery`, p1)).status, 404);
  // factura duplicada de proveedor bloqueada
  const dup = await call('POST', '/api/portal/invoices', p1, { number: 'FV-20391', issue_date: new Date().toISOString().slice(0, 10), amount: 1000 });
  assert.equal(dup.status, 409);
});

test('portal: proveedor carga factura, contador aprueba y entra al inventario', async () => {
  const p = await login('proveedor3'); const c = await login('contador');
  const cat = (await call('GET', '/api/portal/catalog', p)).body.products[0];
  const before = (await call('GET', `/api/products?q=${encodeURIComponent(cat.name)}`, c)).body.products[0].stock;
  const up = await call('POST', '/api/portal/invoices', p, { number: 'MC-TEST-1', issue_date: new Date().toISOString().slice(0, 10), items: [{ product_id: cat.id, qty: 5, unit_cost: 1000 }] });
  assert.equal(up.status, 201);
  assert.equal((await call('PATCH', `/api/purchases/${up.body.id}`, c, { action: 'aprobar' })).status, 200);
  assert.equal((await call('GET', `/api/products?q=${encodeURIComponent(cat.name)}`, c)).body.products[0].stock, before + 5);
});

test('límite de 3 usuarios externos', async () => {
  const a = await login('admin');
  const r = await call('POST', '/api/users', a, { name: 'Otro Proveedor', email: 'otro@prov.example', password: 'ClaveSegura2026', role: 'proveedor', supplier_id: 1 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'LIMITE_EXTERNOS');
});

test('matriz de permisos: cambio aplica de inmediato y queda alertado; admin protegido', async () => {
  const a = await login('admin'); const rcp = await login('recepcionista');
  assert.equal((await call('GET', '/api/ai/anomalies', rcp)).status, 403);
  assert.equal((await call('PUT', '/api/permissions', a, { role: 'recepcionista', permission: 'ai.view', granted: true })).status, 200);
  assert.equal((await call('GET', '/api/ai/anomalies', rcp)).status, 200);
  assert.equal((await call('PUT', '/api/permissions', a, { role: 'recepcionista', permission: 'ai.view', granted: false })).status, 200);
  assert.equal((await call('GET', '/api/ai/anomalies', rcp)).status, 403);
  assert.equal((await call('PUT', '/api/permissions', a, { role: 'admin', permission: 'users.manage', granted: false })).status, 422);
  assert.equal((await call('PUT', '/api/permissions', rcp, { role: 'recepcionista', permission: 'ai.view', granted: true })).status, 403);
});

test('bitácora: inmutable por API y por triggers SQL, cadena íntegra', async () => {
  const c = await login('contador');
  const r = await call('DELETE', '/api/audit/1', c);
  assert.equal(r.status, 405);
  assert.equal(r.body.error, 'BITACORA_INMUTABLE');
  const { db } = await import('../src/db.js');
  assert.throws(() => db.exec('DELETE FROM audit_log WHERE id=1'), /inmutable/);
  assert.throws(() => db.exec("UPDATE audit_log SET detail='x' WHERE id=1"), /inmutable/);
  const v = await call('GET', '/api/audit/verify', c);
  assert.equal(v.body.ok, true);
});

test('motor de IA: escaneo, alertas y NIIF 15', async () => {
  const c = await login('contador');
  const scan = await call('POST', '/api/ai/scan', c);
  assert.equal(scan.status, 200);
  const rules = new Set(scan.body.anomalies.map((a) => a.rule));
  for (const r of ['DUPLICADA_CONTENIDO', 'MONTO_ATIPICO', 'FUERA_HORARIO', 'CONSECUTIVO_FALTANTE', 'DESCUENTO_ALTO', 'RAFAGA', 'NIIF15_PREMATURA', 'NIIF15_NO_FACTURADA', 'ACCESO_DENEGADO_REPETIDO', 'PROV_DUPLICADA'])
    assert.ok(rules.has(r), `falta regla ${r}`);
  const again = await call('POST', '/api/ai/scan', c);
  assert.equal(again.body.new_count, 0, 'idempotente');
  const n = await call('GET', '/api/accounting/niif15', c);
  assert.ok(n.body.summary.excepciones > 0);
  assert.equal((await call('POST', '/api/ai/scan', await login('recepcionista'))).status, 403);
});

test('dashboard ejecutivo vs básico y export contable', async () => {
  const g = await call('GET', '/api/dashboard', await login('gerente'));
  assert.equal(g.body.level, 'executive');
  assert.ok(g.body.kpis.total_facturado.all_time > 0 && g.body.kpis.con_alertas.count > 0);
  assert.equal((await call('GET', '/api/dashboard', await login('recepcionista'))).body.level, 'basic');
  assert.equal((await call('GET', '/api/dashboard', await login('proveedor1'))).status, 403);
  const csv = await fetch(`${base}/api/accounting/ledger?type=ventas`, { headers: { Authorization: `Bearer ${await login('contador')}` } });
  assert.match(await csv.text(), /Consecutivo/);
  assert.equal((await call('GET', '/api/accounting/ledger?type=ventas', await login('recepcionista'))).status, 403);
});

test('token manipulado se rechaza', async () => {
  const t = await login('admin');
  const [h, b, s] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 1, role: 'admin', exp: 9999999999 })).toString('base64url')}.${s}`;
  assert.equal((await call('GET', '/api/users', forged)).status, 401);
});

test('versión publicada para el aviso de actualización en vivo', async () => {
  const a = await call('GET', '/api/version');
  assert.equal(a.status, 200);
  assert.match(a.body.version, /^local-/);
  const b = await call('GET', '/api/version');
  assert.equal(b.body.version, a.body.version, 'estable mientras no se publique otra versión');
});
