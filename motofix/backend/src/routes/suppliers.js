import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { auth, perm, can, notify, denyAccess } from '../auth.js';
import { logEvent, ctxLog } from '../audit.js';
import { upsertAnomaly, detect } from '../anomaly.js';
import { crc } from '../lib/time.js';

/** Registro de factura de proveedor, compartido por el portal externo y el registro interno de compras. */
export function createSupplierInvoice(input, actor, { supplier_id, source, ip, device, now = new Date(), skipDetect = false }) {
  const supplier = get('SELECT * FROM suppliers WHERE id=? AND active=1', supplier_id);
  if (!supplier) throw new HttpError(422, 'PROVEEDOR_NO_AUTORIZADO', 'Solo se pueden registrar compras de los proveedores autorizados y activos');
  const number = v.str(input.number, 'número de factura', { max: 40 });
  const issue_date = v.str(input.issue_date, 'fecha de emisión', { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue_date) || Number.isNaN(Date.parse(issue_date))) throw new HttpError(422, 'VALIDACION', 'fecha de emisión: usa el formato AAAA-MM-DD');
  if (Date.parse(issue_date) > Date.now() + 86400e3) throw new HttpError(422, 'VALIDACION', 'fecha de emisión: no puede ser futura');
  const items = v.array(input.items ?? [], 'ítems', { max: 40 }).map((it, k) => {
    const p = get('SELECT id,name FROM products WHERE id=? AND active=1 AND type != ?', Number(it.product_id), 'servicio');
    if (!p) throw new HttpError(404, 'NO_ENCONTRADO', `Ítem ${k + 1}: producto no existe`);
    return { product_id: p.id, name: p.name, qty: v.num(it.qty, `ítem ${k + 1} cantidad`, { int: true, min: 1, max: 100000 }), unit_cost: v.num(it.unit_cost, `ítem ${k + 1} costo`, { int: true, min: 1, max: 100_000_000 }) };
  });
  const amount = items.length ? items.reduce((s, i) => s + i.qty * i.unit_cost, 0) : v.num(input.amount, 'monto', { int: true, min: 1, max: 1_000_000_000 });
  const hash = crypto.createHash('sha256').update(JSON.stringify({ s: supplier_id, a: amount, d: issue_date, i: items.map((i) => `${i.product_id}|${i.qty}|${i.unit_cost}`).sort() })).digest('hex');

  const block = (existing, why) => {
    logEvent({ user: actor, action: 'DUPLICADO_BLOQUEADO', entity: 'factura_proveedor', entityId: existing.id, detail: `${supplier.name}: ${why} (${number}, ${crc(amount)})`, ip, device, ts: now.toISOString() });
    upsertAnomaly({ rule: 'DUPLICADO_BLOQUEADO', severity: 'alta', ref_type: 'supplier_invoice', ref_id: existing.id, ref_label: `${supplier.name} · ${existing.number}`,
      title: `Intento de factura duplicada de ${supplier.name}`, detail: `${actor.name} intentó registrar ${number} por ${crc(amount)}: ${why}. Bloqueado por el validador anti-duplicación.`,
      dedupe_key: `supdup:${hash}:${now.toISOString().slice(0, 16)}`, ts: now.toISOString() });
    throw new HttpError(409, 'FACTURA_DUPLICADA', `Bloqueado: ${why}.`, { duplicateOf: existing.number });
  };
  const byNumber = get('SELECT id,number FROM supplier_invoices WHERE supplier_id=? AND LOWER(number)=LOWER(?)', supplier_id, number);
  if (byNumber) block(byNumber, `el número ${number} ya fue registrado por este proveedor`);
  const byHash = get("SELECT id,number FROM supplier_invoices WHERE content_hash=? AND status!='rechazada'", hash);
  if (byHash) block(byHash, `coincide en monto, fecha e ítems con la factura ${byHash.number}`);

  const res = run(`INSERT INTO supplier_invoices (supplier_id,number,description,amount,issue_date,status,source,items_json,content_hash,uploaded_by,created_at)
                   VALUES (?,?,?,?,?,'pendiente',?,?,?,?,?)`,
    supplier_id, number, v.str(input.description, 'descripción', { optional: true, max: 200 }), amount, issue_date, source, JSON.stringify(items), hash, actor.id, now.toISOString());
  const id = Number(res.lastInsertRowid);
  logEvent({ user: actor, action: 'CREACION', entity: 'factura_proveedor', entityId: id, ip, device, ts: now.toISOString(), detail: `${supplier.name} · ${number} · ${crc(amount)} (${source})` });
  notify({ level: 'info', title: `Nueva factura de ${supplier.name}`, body: `${number} por ${crc(amount)} pendiente de revisión.`, link: '/compras', ts: now.toISOString() });
  if (!skipDetect) detect();
  return get('SELECT * FROM supplier_invoices WHERE id=?', id);
}

const withSupplier = (rows) => rows.map((x) => ({ ...x, items: JSON.parse(x.items_json) }));
const SELECT_SI = `SELECT s.*, p.name supplier_name, u.name uploaded_by_name FROM supplier_invoices s JOIN suppliers p ON p.id=s.supplier_id LEFT JOIN users u ON u.id=s.uploaded_by`;

export function supplierRoutes(r) {
  // ---------- Compras internas (PRD 1.3.2) ----------
  r.get('/api/suppliers', auth, perm('purchases.view', 'purchases.create', 'users.manage'), () => ({
    suppliers: all('SELECT * FROM suppliers ORDER BY id'),
  }));

  r.get('/api/purchases', auth, perm('purchases.view'), (ctx) => ({
    purchases: withSupplier(all(`${SELECT_SI} ${ctx.query.status ? 'WHERE s.status = ?' : ''} ORDER BY s.id DESC LIMIT 200`, ...(ctx.query.status ? [ctx.query.status] : []))),
  }));

  r.post('/api/purchases', auth, perm('purchases.create'), (ctx) => {
    const row = createSupplierInvoice(ctx.body, ctx.user, { supplier_id: Number(ctx.body.supplier_id), source: 'interno', ip: ctx.ip, device: ctx.device });
    ctx.status = 201;
    return row;
  });

  r.patch('/api/purchases/:id', auth, perm('purchases.approve'), (ctx) => {
    const s = get('SELECT * FROM supplier_invoices WHERE id=?', Number(ctx.params.id));
    if (!s) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura de compra no encontrada');
    const action = v.oneOf(ctx.body.action, 'acción', ['aprobar', 'rechazar', 'pagar']);
    const now = new Date().toISOString();
    if (action === 'aprobar') {
      if (s.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${s.status}`);
      tx(() => {
        run("UPDATE supplier_invoices SET status='aprobada', resolved_by=?, stock_applied=1 WHERE id=?", ctx.user.id, s.id);
        for (const it of JSON.parse(s.items_json)) { // entrada automática de inventario
          run('UPDATE products SET stock = stock + ?, cost = ? WHERE id=?', it.qty, it.unit_cost, it.product_id);
          run("INSERT INTO stock_movements (product_id,qty,reason,ref_type,ref_id,note,user_id,created_at) VALUES (?,?,'compra','supplier_invoice',?,?,?,?)", it.product_id, it.qty, s.id, `Factura ${s.number}`, ctx.user.id, now);
        }
      });
    } else if (action === 'rechazar') {
      if (s.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${s.status}`);
      run("UPDATE supplier_invoices SET status='rechazada', reject_reason=?, resolved_by=? WHERE id=?", v.str(ctx.body.reason, 'motivo', { min: 5, max: 200 }), ctx.user.id, s.id);
    } else {
      if (s.status !== 'aprobada') throw new HttpError(409, 'ESTADO_INVALIDO', 'Solo se pueden pagar facturas aprobadas');
      run("UPDATE supplier_invoices SET status='pagada', resolved_by=? WHERE id=?", ctx.user.id, s.id);
    }
    ctxLog(ctx, 'MODIFICACION', 'factura_proveedor', s.id, `${s.number}: ${action} (${crc(s.amount)})`);
    return get(`${SELECT_SI} WHERE s.id=?`, s.id);
  });

  // ---------- Portal de proveedores externos (PRD 1.2.2) ----------
  const supplierScope = (ctx) => {
    if (ctx.user.supplier_id) return ctx.user.supplier_id;       // proveedor: SOLO su empresa (aislamiento de datos)
    const q = Number(ctx.query.supplier_id);                      // admin: supervisión de cualquiera
    return q || null;
  };

  r.get('/api/portal/summary', auth, perm('supplier.portal'), (ctx) => {
    const sid = supplierScope(ctx);
    const where = sid ? 'WHERE s.supplier_id = ?' : '';
    const rows = withSupplier(all(`${SELECT_SI} ${where} ORDER BY s.id DESC LIMIT 200`, ...(sid ? [sid] : [])));
    const tot = (st) => rows.filter((x) => st.includes(x.status)).reduce((a, x) => ({ count: a.count + 1, amount: a.amount + x.amount }), { count: 0, amount: 0 });
    return {
      supplier: sid ? get('SELECT * FROM suppliers WHERE id=?', sid) : null,
      suppliers: sid ? undefined : all('SELECT * FROM suppliers ORDER BY id'),
      accounts: { en_revision: tot(['pendiente']), por_cobrar: tot(['aprobada']), cobrado: tot(['pagada']), rechazado: tot(['rechazada']) },
      invoices: rows,
    };
  });

  r.get('/api/portal/catalog', auth, perm('supplier.portal'), () => ({
    products: all("SELECT id, sku, name, type FROM products WHERE active=1 AND type != 'servicio' ORDER BY name"),
  }));

  r.post('/api/portal/invoices', auth, perm('supplier.portal'), (ctx) => {
    if (!ctx.user.supplier_id) denyAccess(ctx, 'supplier.portal', 'cargar facturas de proveedor (solo cuentas de proveedor)');
    const row = createSupplierInvoice(ctx.body, ctx.user, { supplier_id: ctx.user.supplier_id, source: 'portal', ip: ctx.ip, device: ctx.device });
    ctx.status = 201;
    return row;
  });

  r.post('/api/portal/invoices/:id/confirm-delivery', auth, perm('supplier.portal'), (ctx) => {
    if (!ctx.user.supplier_id) denyAccess(ctx, 'supplier.portal', 'confirmar entregas (solo cuentas de proveedor)');
    const s = get('SELECT * FROM supplier_invoices WHERE id=? AND supplier_id=?', Number(ctx.params.id), ctx.user.supplier_id);
    if (!s) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada'); // misma respuesta si pertenece a otro proveedor
    if (s.status === 'rechazada') throw new HttpError(409, 'ESTADO_INVALIDO', 'La factura fue rechazada');
    if (s.delivery_confirmed) throw new HttpError(409, 'ESTADO_INVALIDO', 'La entrega ya fue confirmada');
    run('UPDATE supplier_invoices SET delivery_confirmed=1, delivered_at=? WHERE id=?', new Date().toISOString(), s.id);
    ctxLog(ctx, 'MODIFICACION', 'factura_proveedor', s.id, `Entrega confirmada para ${s.number}`);
    notify({ level: 'info', title: 'Entrega confirmada por proveedor', body: `${ctx.user.name} confirmó la entrega de ${s.number}.`, link: '/compras' });
    return get(`${SELECT_SI} WHERE s.id=?`, s.id);
  });
}
