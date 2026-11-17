import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { logEvent } from '../audit.js';
import { notify } from '../auth.js';
import { upsertAnomaly, detect } from '../anomaly.js';
import { localParts, crc } from '../lib/time.js';

export const fmtNumber = (n) => `F-${String(n).padStart(6, '0')}`;
export function nextInvoiceNumber() {
  const r = get("SELECT MAX(CAST(SUBSTR(number,3) AS INTEGER)) m FROM invoices");
  return fmtNumber((r?.m || 0) + 1);
}

/** Huella del contenido (PRD 1.3.3): cliente + orden + líneas normalizadas + total + día local. */
export function contentHash({ customer_id, work_order_id, items, total, day }) {
  const lines = items.map((i) => `${i.product_id ?? i.description.toLowerCase()}|${i.qty}|${i.unit_price}`).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ c: customer_id ?? 0, w: work_order_id ?? 0, lines, total, day })).digest('hex');
}

export function computeTotals(subtotal, discountPct) {
  const discount = Math.round((subtotal * discountPct) / 100);
  const base = subtotal - discount;
  const tax = Math.round(base * config.taxRate);
  return { subtotal, discount, tax, total: base + tax };
}

export function getInvoiceDetail(id) {
  const inv = get(`SELECT i.*, c.name customer_name, c.id_number customer_id_number, u.name created_by_name, w.number work_order_number
                   FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN users u ON u.id=i.created_by
                   LEFT JOIN work_orders w ON w.id=i.work_order_id WHERE i.id=?`, id);
  if (!inv) return null;
  inv.items = all('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id', id);
  inv.anomalies = all("SELECT id,rule,severity,title,detail,status FROM anomalies WHERE ref_type='invoice' AND ref_id=? ORDER BY score DESC", id);
  inv.approvals = all(`SELECT a.*, r.name requested_by_name, s.name resolved_by_name FROM approval_requests a
                       JOIN users r ON r.id=a.requested_by LEFT JOIN users s ON s.id=a.resolved_by WHERE a.invoice_id=? ORDER BY a.id DESC`, id);
  return inv;
}

/**
 * Emite una factura. La autorización (permisos) la resuelve la ruta; este servicio aplica las reglas de negocio:
 * catálogo como fuente de precios, stock suficiente, control anti-duplicación, ajuste automático de inventario.
 */
export function createInvoice(input, actor, opts = {}) {
  const { ip = null, device = null, now = new Date(), forceNumber = null, discountApprovedBy = null, canOverride = false } = opts;
  const kind = v.oneOf(input.kind, 'tipo', ['venta', 'servicio']);
  const rawItems = v.array(input.items, 'líneas', { min: 0, max: 40 });
  const pct = v.num(input.discount_pct ?? 0, 'descuento %', { min: 0, max: 50 });
  const notes = v.str(input.notes, 'notas', { optional: true, max: 400 });

  let work_order_id = null;
  let customer_id = input.customer_id ? v.num(input.customer_id, 'cliente', { int: true, min: 1 }) : null;
  let wo = null;
  if (input.work_order_id) {
    wo = get('SELECT * FROM work_orders WHERE id=?', Number(input.work_order_id));
    if (!wo) throw new HttpError(404, 'NO_ENCONTRADO', 'La orden de trabajo no existe');
    if (wo.status === 'facturada') throw new HttpError(409, 'ORDEN_FACTURADA', `La orden ${wo.number} ya fue facturada`);
    if (wo.status !== 'completada') throw new HttpError(422, 'ORDEN_NO_COMPLETADA', `La orden ${wo.number} aún no está completada (NIIF 15: el ingreso se reconoce al cumplir la obligación)`);
    work_order_id = wo.id;
    customer_id = wo.customer_id;
  }
  if (kind === 'servicio' && !customer_id) throw new HttpError(422, 'VALIDACION', 'cliente: las facturas de servicio requieren un cliente');
  if (customer_id && !get('SELECT 1 x FROM customers WHERE id=?', customer_id)) throw new HttpError(404, 'NO_ENCONTRADO', 'El cliente no existe');

  // Normalizar líneas: el precio de catálogo manda; solo las líneas libres aceptan precio manual.
  const items = rawItems.map((it, idx) => {
    const qty = v.num(it.qty, `línea ${idx + 1} cantidad`, { int: true, min: 1, max: 999 });
    if (it.product_id) {
      const p = get('SELECT * FROM products WHERE id=? AND active=1', Number(it.product_id));
      if (!p) throw new HttpError(404, 'NO_ENCONTRADO', `Producto ${it.product_id} no existe o está inactivo`);
      return { product_id: p.id, description: p.name, qty, unit_price: p.price, type: p.type, stock: p.stock, sku: p.sku };
    }
    return { product_id: null, description: v.str(it.description, `línea ${idx + 1} descripción`, { max: 160 }), qty,
      unit_price: v.num(it.unit_price, `línea ${idx + 1} precio`, { int: true, min: 0, max: 50_000_000 }), type: 'servicio' };
  });
  if (wo) {
    // Al facturar una orden, la mano de obra se factura como línea libre si no viene incluida.
    if (!items.length) throw new HttpError(422, 'VALIDACION', 'líneas: agrega al menos una línea a facturar');
  }
  if (!items.length) throw new HttpError(422, 'VALIDACION', 'líneas: agrega al menos una línea');

  // Stock suficiente (suma por producto)
  const need = new Map();
  for (const i of items) if (i.product_id && i.type !== 'servicio') need.set(i.product_id, (need.get(i.product_id) || 0) + i.qty);
  for (const [pid, q] of need) {
    const p = get('SELECT name, stock FROM products WHERE id=?', pid);
    if (p.stock < q) throw new HttpError(422, 'STOCK_INSUFICIENTE', `Stock insuficiente de «${p.name}»: disponible ${p.stock}, solicitado ${q}`);
  }

  const subtotal = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const t = computeTotals(subtotal, pct);
  const day = localParts(now.toISOString()).date;
  const hash = contentHash({ customer_id, work_order_id, items, total: t.total, day });

  // Control preventivo anti-duplicación
  const dup = get("SELECT id, number FROM invoices WHERE content_hash=? AND status != 'anulada' ORDER BY id LIMIT 1", hash);
  let override_reason = null;
  if (dup) {
    const who = { user: actor, ip, device, ts: now.toISOString() };
    if (!canOverride) {
      logEvent({ ...who, action: 'DUPLICADO_BLOQUEADO', entity: 'factura', entityId: dup.id, detail: `Intento de duplicar ${dup.number} (${crc(t.total)})` });
      upsertAnomaly({ rule: 'DUPLICADO_BLOQUEADO', severity: 'alta', ref_type: 'invoice', ref_id: dup.id, ref_label: dup.number,
        title: `Intento de duplicar la factura ${dup.number}`, detail: `${actor.name} (${actor.role}) intentó guardar una factura idéntica por ${crc(t.total)}. El sistema la bloqueó.`,
        dedupe_key: `dupblock:${hash}:${now.toISOString().slice(0, 16)}`, ts: now.toISOString() });
      throw new HttpError(409, 'FACTURA_DUPLICADA', `Bloqueado: ya existe la factura ${dup.number} con el mismo cliente, líneas y monto emitida hoy. Si es legítima, solicita autorización a un Gerente.`, { duplicateOf: dup.number, duplicateId: dup.id });
    }
    override_reason = v.str(input.override_reason, 'justificación', { min: 10, max: 300 });
  }

  const created = tx(() => {
    const number = forceNumber || nextInvoiceNumber();
    const paid = input.paid === true;
    const r = run(`INSERT INTO invoices (number,kind,customer_id,work_order_id,quote_id,subtotal,discount,tax,total,status,content_hash,discount_approved_by,override_reason,notes,created_by,created_at,paid_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      number, kind, customer_id, work_order_id, input.quote_id ? Number(input.quote_id) : null, t.subtotal, t.discount, t.tax, t.total,
      paid ? 'pagada' : 'pendiente', hash, pct > 0 ? discountApprovedBy : null, override_reason, notes, actor.id, now.toISOString(), paid ? now.toISOString() : null);
    const id = Number(r.lastInsertRowid);
    for (const i of items) {
      run('INSERT INTO invoice_items (invoice_id,product_id,description,qty,unit_price,line_total) VALUES (?,?,?,?,?,?)', id, i.product_id, i.description, i.qty, i.unit_price, i.qty * i.unit_price);
      if (i.product_id && i.type !== 'servicio') {
        run('UPDATE products SET stock = stock - ? WHERE id=?', i.qty, i.product_id);
        run("INSERT INTO stock_movements (product_id,qty,reason,ref_type,ref_id,user_id,created_at) VALUES (?,?,'venta','invoice',?,?,?)", i.product_id, -i.qty, id, actor.id, now.toISOString());
      }
    }
    if (wo) run("UPDATE work_orders SET status='facturada' WHERE id=?", wo.id);
    if (input.quote_id) run("UPDATE quotes SET status='facturada' WHERE id=?", Number(input.quote_id));
    return { id, number };
  });

  logEvent({ user: actor, action: 'CREACION', entity: 'factura', entityId: created.id, ip, device, ts: now.toISOString(),
    detail: `${created.number} · ${crc(t.total)}${pct ? ` · desc. ${pct}%` : ''}${wo ? ` · ${wo.number}` : ''}${override_reason ? ' · duplicado autorizado' : ''}` });
  // Alerta de stock bajo
  for (const [pid] of need) {
    const p = get('SELECT name, stock, min_stock FROM products WHERE id=?', pid);
    if (p.stock <= p.min_stock) notify({ level: 'warning', title: `Stock bajo: ${p.name}`, body: `Quedan ${p.stock} unidades (mínimo ${p.min_stock}).`, link: '/inventario', ts: now.toISOString() });
  }
  if (!opts.skipDetect) detect();
  return getInvoiceDetail(created.id);
}

export function payInvoice(id, actor, { ip, device, now = new Date() } = {}) {
  const inv = get('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
  if (inv.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', `La factura está ${inv.status}`);
  run("UPDATE invoices SET status='pagada', paid_at=? WHERE id=?", now.toISOString(), id);
  logEvent({ user: actor, action: 'MODIFICACION', entity: 'factura', entityId: id, ip, device, detail: `${inv.number} marcada como pagada (${crc(inv.total)})` });
  return getInvoiceDetail(id);
}

export function voidInvoice(id, actor, { reason, ip, device, approvedBy = null, now = new Date() }) {
  const inv = get('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
  if (inv.status === 'anulada') throw new HttpError(409, 'ESTADO_INVALIDO', 'La factura ya está anulada');
  const why = v.str(reason, 'motivo', { min: 5, max: 300 });
  tx(() => {
    run("UPDATE invoices SET status='anulada', voided_at=?, void_reason=? WHERE id=?", now.toISOString(), why, id);
    for (const it of all('SELECT * FROM invoice_items WHERE invoice_id=? AND product_id IS NOT NULL', id)) {
      const p = get('SELECT type FROM products WHERE id=?', it.product_id);
      if (p.type === 'servicio') continue;
      run('UPDATE products SET stock = stock + ? WHERE id=?', it.qty, it.product_id);
      run("INSERT INTO stock_movements (product_id,qty,reason,ref_type,ref_id,user_id,created_at) VALUES (?,?,'anulacion','invoice',?,?,?)", it.product_id, it.qty, id, actor.id, now.toISOString());
    }
    if (inv.work_order_id) run("UPDATE work_orders SET status='completada' WHERE id=?", inv.work_order_id);
  });
  logEvent({ user: actor, action: 'ELIMINACION', entity: 'factura', entityId: id, ip, device, ts: now.toISOString(),
    detail: `Anulación de ${inv.number} (${crc(inv.total)}). Motivo: ${why}${approvedBy ? ` · aprobada por ${approvedBy.name}` : ''}` });
  detect();
  return getInvoiceDetail(id);
}

export function applyDiscount(id, pct, approver, actor, { ip, device }) {
  const inv = get('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
  if (inv.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', 'Solo se puede aplicar descuento a facturas pendientes de cobro');
  const t = computeTotals(inv.subtotal, v.num(pct, 'descuento %', { min: 1, max: 50 }));
  run('UPDATE invoices SET discount=?, tax=?, total=?, discount_approved_by=? WHERE id=?', t.discount, t.tax, t.total, approver.id, id);
  logEvent({ user: actor, action: 'MODIFICACION', entity: 'factura', entityId: id, ip, device,
    detail: `${inv.number}: descuento ${pct}% aprobado por ${approver.name}. Nuevo total ${crc(t.total)}` });
  detect();
  return getInvoiceDetail(id);
}
