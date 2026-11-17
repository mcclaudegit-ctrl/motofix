import { all, get, run, tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { auth, perm, can, notify, denyAccess } from '../auth.js';
import { ctxLog } from '../audit.js';
import { createInvoice, getInvoiceDetail, nextInvoiceNumber, payInvoice, voidInvoice, applyDiscount, computeTotals } from '../services/invoices.js';
import { detect } from '../anomaly.js';
import { crc } from '../lib/time.js';

export function billingRoutes(r) {
  // ---------- Facturas ----------
  r.get('/api/invoices', auth, perm('invoices.view'), (ctx) => {
    const { status, kind, q, flagged } = ctx.query;
    const limit = Math.min(Number(ctx.query.limit) || 200, 500);
    const offset = Number(ctx.query.offset) || 0;
    const where = []; const p = [];
    if (status) { where.push('i.status = ?'); p.push(status); }
    if (kind) { where.push('i.kind = ?'); p.push(kind); }
    if (q) { where.push('(i.number LIKE ? OR c.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
    if (flagged === '1') where.push("EXISTS (SELECT 1 FROM anomalies a WHERE a.ref_type='invoice' AND a.ref_id=i.id AND a.status='abierta')");
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = all(`SELECT i.id,i.number,i.kind,i.status,i.subtotal,i.discount,i.tax,i.total,i.created_at,i.work_order_id,
        c.name customer_name, u.name created_by_name, u.role created_by_role,
        (SELECT COUNT(*) FROM anomalies a WHERE a.ref_type='invoice' AND a.ref_id=i.id AND a.status='abierta') alerts,
        (SELECT MAX(score) FROM anomalies a WHERE a.ref_type='invoice' AND a.ref_id=i.id AND a.status='abierta') max_score,
        (SELECT COUNT(*) FROM approval_requests ar WHERE ar.invoice_id=i.id AND ar.status='pendiente') pending_requests
      FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN users u ON u.id=i.created_by
      ${W} ORDER BY i.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    const total = get(`SELECT COUNT(*) n FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ${W}`, ...p).n;
    return { invoices: rows, total };
  });

  r.get('/api/invoices/next-number', auth, perm('invoices.create'), () => ({ number: nextInvoiceNumber() }));

  r.get('/api/invoices/:id', auth, perm('invoices.view'), (ctx) => {
    const inv = getInvoiceDetail(Number(ctx.params.id));
    if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
    return inv;
  });

  r.post('/api/invoices', auth, perm('invoices.create'), (ctx) => {
    const b = ctx.body;
    const pct = Number(b.discount_pct || 0);
    if (pct > 0 && !can(ctx, 'invoices.discount')) denyAccess(ctx, 'invoices.discount', 'aplicar descuentos al emitir una factura');
    if (b.paid === true && !can(ctx, 'invoices.pay')) denyAccess(ctx, 'invoices.pay');
    if (b.override_duplicate === true && !can(ctx, 'approvals.resolve')) denyAccess(ctx, 'approvals.resolve', 'autorizar la emisión de una factura duplicada');
    const inv = createInvoice(b, ctx.user, {
      ip: ctx.ip, device: ctx.device, discountApprovedBy: pct > 0 ? ctx.user.id : null, canOverride: b.override_duplicate === true,
    });
    ctx.status = 201;
    return inv;
  });

  r.post('/api/invoices/:id/pay', auth, perm('invoices.pay'), (ctx) => payInvoice(Number(ctx.params.id), ctx.user, ctx));

  // Anulación directa: solo roles con 'invoices.void' (Admin/Gerente). Los demás deben solicitarla (módulo de aprobaciones).
  r.post('/api/invoices/:id/void', auth, perm('invoices.void'), (ctx) =>
    voidInvoice(Number(ctx.params.id), ctx.user, { reason: ctx.body.reason, ip: ctx.ip, device: ctx.device }));

  // ---------- Solicitud y aprobación de anulaciones / descuentos (PRD 1.3.4) ----------
  r.get('/api/approvals', auth, perm('approvals.request', 'approvals.resolve'), (ctx) => {
    const rows = all(`SELECT a.*, i.number invoice_number, i.total invoice_total, i.subtotal invoice_subtotal, c.name customer_name,
        r.name requested_by_name, s.name resolved_by_name
      FROM approval_requests a JOIN invoices i ON i.id=a.invoice_id LEFT JOIN customers c ON c.id=i.customer_id
      JOIN users r ON r.id=a.requested_by LEFT JOIN users s ON s.id=a.resolved_by
      ${ctx.query.status ? 'WHERE a.status = ?' : ''} ORDER BY CASE a.status WHEN 'pendiente' THEN 0 ELSE 1 END, a.id DESC LIMIT 200`, ...(ctx.query.status ? [ctx.query.status] : []));
    return { approvals: rows };
  });

  r.post('/api/approvals', auth, perm('approvals.request'), (ctx) => {
    const type = v.oneOf(ctx.body.type, 'tipo', ['anulacion', 'descuento']);
    const inv = get('SELECT * FROM invoices WHERE id=?', Number(ctx.body.invoice_id));
    if (!inv) throw new HttpError(404, 'NO_ENCONTRADO', 'Factura no encontrada');
    if (inv.status === 'anulada') throw new HttpError(409, 'ESTADO_INVALIDO', 'La factura ya está anulada');
    if (type === 'descuento' && inv.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', 'Solo se puede solicitar descuento en facturas pendientes de cobro');
    const reason = v.str(ctx.body.reason, 'motivo', { min: 10, max: 300 });
    const pct = type === 'descuento' ? v.num(ctx.body.pct, 'descuento %', { min: 1, max: 50 }) : null;
    if (get("SELECT 1 x FROM approval_requests WHERE invoice_id=? AND type=? AND status='pendiente'", inv.id, type)) throw new HttpError(409, 'SOLICITUD_EXISTENTE', 'Ya hay una solicitud pendiente de este tipo para la factura');
    const res = run("INSERT INTO approval_requests (type,invoice_id,requested_by,reason,pct,status,created_at) VALUES (?,?,?,?,?,'pendiente',?)", type, inv.id, ctx.user.id, reason, pct, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    ctxLog(ctx, 'CREACION', 'solicitud', id, `Solicitud de ${type === 'anulacion' ? 'anulación' : `descuento ${pct}%`} para ${inv.number}: ${reason}`);
    notify({ audience: 'security', level: 'info', title: `Nueva solicitud de ${type === 'anulacion' ? 'anulación' : 'descuento'}`, body: `${ctx.user.name} · ${inv.number} (${crc(inv.total)})`, link: '/aprobaciones' });
    detect();
    ctx.status = 201;
    return { id, status: 'pendiente' };
  });

  r.patch('/api/approvals/:id', auth, perm('approvals.resolve'), (ctx) => {
    const a = get('SELECT * FROM approval_requests WHERE id=?', Number(ctx.params.id));
    if (!a) throw new HttpError(404, 'NO_ENCONTRADO', 'Solicitud no encontrada');
    if (a.status !== 'pendiente') throw new HttpError(409, 'ESTADO_INVALIDO', 'La solicitud ya fue resuelta');
    // Segregación de funciones: nadie aprueba su propia solicitud.
    if (a.requested_by === ctx.user.id) throw new HttpError(403, 'SEGREGACION_FUNCIONES', 'No puedes resolver una solicitud creada por ti. Debe hacerlo otra persona autorizada.');
    const decision = v.oneOf(ctx.body.decision, 'decisión', ['aprobada', 'rechazada']);
    const note = v.str(ctx.body.note, 'nota', { optional: true, max: 300 });
    if (decision === 'rechazada' && !note) throw new HttpError(422, 'VALIDACION', 'nota: indica el motivo del rechazo');
    // Primero se ejecuta la acción (si falla, la solicitud sigue pendiente); luego se cierra la solicitud.
    if (decision === 'aprobada') {
      if (a.type === 'anulacion') voidInvoice(a.invoice_id, ctx.user, { reason: a.reason, ip: ctx.ip, device: ctx.device, approvedBy: ctx.user });
      else applyDiscount(a.invoice_id, a.pct, ctx.user, ctx.user, ctx);
    }
    run('UPDATE approval_requests SET status=?, resolved_by=?, resolution_note=?, resolved_at=? WHERE id=?', decision, ctx.user.id, note, new Date().toISOString(), a.id);
    ctxLog(ctx, 'APROBACION', 'solicitud', a.id, `${decision === 'aprobada' ? 'Aprobó' : 'Rechazó'} ${a.type} de factura #${a.invoice_id}${note ? `: ${note}` : ''}`);
    notify({ audience: 'user', userId: a.requested_by, level: decision === 'aprobada' ? 'info' : 'warning',
      title: `Solicitud ${decision}`, body: `Tu solicitud de ${a.type} fue ${decision} por ${ctx.user.name}.`, link: '/aprobaciones' });
    return { ok: true, status: decision };
  });

  // ---------- Cotizaciones y precuentas ----------
  r.get('/api/quotes', auth, perm('quotes.view'), () => {
    const rows = all(`SELECT q.*, u.name created_by_name, c.name cname FROM quotes q LEFT JOIN users u ON u.id=q.created_by LEFT JOIN customers c ON c.id=q.customer_id ORDER BY q.id DESC LIMIT 200`);
    return { quotes: rows.map((q) => ({ ...q, customer_name: q.cname || q.customer_name, items: JSON.parse(q.items_json) })) };
  });

  r.post('/api/quotes', auth, perm('quotes.create'), (ctx) => {
    const type = v.oneOf(ctx.body.type || 'cotizacion', 'tipo', ['cotizacion', 'precuenta']);
    const raw = v.array(ctx.body.items, 'líneas', { min: 1, max: 40 });
    const items = raw.map((it, k) => {
      const qty = v.num(it.qty, `línea ${k + 1} cantidad`, { int: true, min: 1, max: 999 });
      if (it.product_id) {
        const p = get('SELECT * FROM products WHERE id=? AND active=1', Number(it.product_id));
        if (!p) throw new HttpError(404, 'NO_ENCONTRADO', `Producto ${it.product_id} no existe`);
        return { product_id: p.id, description: p.name, qty, unit_price: p.price };
      }
      return { product_id: null, description: v.str(it.description, `línea ${k + 1} descripción`, { max: 160 }), qty, unit_price: v.num(it.unit_price, `línea ${k + 1} precio`, { int: true, min: 0 }) };
    });
    const customer_id = ctx.body.customer_id ? Number(ctx.body.customer_id) : null;
    const customer_name = customer_id ? null : v.str(ctx.body.customer_name, 'cliente', { max: 120 });
    const t = computeTotals(items.reduce((s, i) => s + i.qty * i.unit_price, 0), 0);
    const n = (get('SELECT COUNT(*) n FROM quotes').n || 0) + 1;
    const number = `${type === 'cotizacion' ? 'C' : 'P'}-${String(n).padStart(5, '0')}`;
    const res = run("INSERT INTO quotes (number,type,customer_id,customer_name,items_json,total,status,notes,created_by,created_at) VALUES (?,?,?,?,?,?,'borrador',?,?,?)",
      number, type, customer_id, customer_name, JSON.stringify(items), t.total, v.str(ctx.body.notes, 'notas', { optional: true, max: 300 }), ctx.user.id, new Date().toISOString());
    ctxLog(ctx, 'CREACION', type === 'cotizacion' ? 'cotizacion' : 'precuenta', Number(res.lastInsertRowid), `${number} · ${crc(t.total)}`);
    ctx.status = 201;
    return { id: Number(res.lastInsertRowid), number, total: t.total };
  });

  r.patch('/api/quotes/:id', auth, perm('quotes.create'), (ctx) => {
    const q = get('SELECT * FROM quotes WHERE id=?', Number(ctx.params.id));
    if (!q) throw new HttpError(404, 'NO_ENCONTRADO', 'No encontrada');
    const status = v.oneOf(ctx.body.status, 'estado', ['enviada', 'aceptada']);
    if (q.status === 'facturada') throw new HttpError(409, 'ESTADO_INVALIDO', 'Ya fue facturada');
    run('UPDATE quotes SET status=? WHERE id=?', status, q.id);
    ctxLog(ctx, 'MODIFICACION', 'cotizacion', q.id, `${q.number} → ${status}`);
    return { ok: true };
  });
}
