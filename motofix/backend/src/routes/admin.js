import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { HttpError, Raw, rateLimit } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { hashPassword } from '../lib/password.js';
import { PERMISSIONS, ROLES, ADMIN_PROTECTED } from '../permissions.js';
import { auth, perm, can, notify, denyAccess } from '../auth.js';
import { logEvent, ctxLog, verifyChain } from '../audit.js';
import { detect, listAnomalies } from '../anomaly.js';
import { niif15Report } from '../niif15.js';
import { crc, localParts } from '../lib/time.js';

const PUBLIC_USER = 'u.id,u.name,u.email,u.role,u.supplier_id,u.active,u.created_at,s.name supplier_name';

export function adminRoutes(r) {
  // ---------- Gestión de usuarios (PRD 1.2.1 / 1.2.2) ----------
  r.get('/api/users', auth, perm('users.manage'), () => ({
    users: all(`SELECT ${PUBLIC_USER} FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id ORDER BY u.id`).map((u) => ({ ...u, roleLabel: ROLES[u.role].label })),
  }));

  const externalCount = (excludeId = 0) => get("SELECT COUNT(*) n FROM users WHERE role='proveedor' AND active=1 AND id != ?", excludeId).n;

  r.post('/api/users', auth, perm('users.manage'), (ctx) => {
    const b = ctx.body;
    const role = v.oneOf(b.role, 'rol', Object.keys(ROLES));
    const email = v.email(b.email);
    const password = v.str(b.password, 'contraseña', { min: 10, max: 100 });
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new HttpError(422, 'VALIDACION', 'contraseña: debe combinar letras y números (mín. 10 caracteres)');
    if (get('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpError(409, 'EMAIL_DUPLICADO', 'Ya existe un usuario con ese correo');
    let supplier_id = null;
    if (role === 'proveedor') {
      supplier_id = v.num(b.supplier_id, 'proveedor', { int: true, min: 1 });
      if (!get('SELECT 1 x FROM suppliers WHERE id=? AND active=1', supplier_id)) throw new HttpError(422, 'PROVEEDOR_NO_AUTORIZADO', 'El proveedor no existe o no está activo');
      if (externalCount() >= config.maxExternalSuppliers) throw new HttpError(422, 'LIMITE_EXTERNOS', `Solo se permiten ${config.maxExternalSuppliers} usuarios externos (proveedores autorizados)`);
    }
    const res = run('INSERT INTO users (name,email,password_hash,role,supplier_id,active,created_at) VALUES (?,?,?,?,?,1,?)',
      v.str(b.name, 'nombre', { max: 100 }), email, hashPassword(password), role, supplier_id, new Date().toISOString());
    ctxLog(ctx, 'CREACION', 'usuario', Number(res.lastInsertRowid), `${email} · rol ${role}`);
    ctx.status = 201;
    return get(`SELECT ${PUBLIC_USER} FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.id=?`, Number(res.lastInsertRowid));
  });

  r.patch('/api/users/:id', auth, perm('users.manage'), (ctx) => {
    const u = get('SELECT * FROM users WHERE id=?', Number(ctx.params.id));
    if (!u) throw new HttpError(404, 'NO_ENCONTRADO', 'Usuario no encontrado');
    const b = ctx.body;
    const changes = [];
    const role = b.role !== undefined ? v.oneOf(b.role, 'rol', Object.keys(ROLES)) : u.role;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
    if (u.id === ctx.user.id && (role !== u.role || !active)) throw new HttpError(422, 'AUTOBLOQUEO', 'No puedes cambiar tu propio rol ni desactivarte');
    if (u.role === 'admin' && (role !== 'admin' || !active) && get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id != ?", u.id).n === 0)
      throw new HttpError(422, 'ULTIMO_ADMIN', 'Debe existir al menos un administrador activo');
    let supplier_id = b.supplier_id !== undefined ? b.supplier_id : u.supplier_id;
    if (role === 'proveedor') {
      if (!supplier_id || !get('SELECT 1 x FROM suppliers WHERE id=? AND active=1', Number(supplier_id))) throw new HttpError(422, 'PROVEEDOR_NO_AUTORIZADO', 'Selecciona un proveedor autorizado');
      if (active && externalCount(u.id) >= config.maxExternalSuppliers) throw new HttpError(422, 'LIMITE_EXTERNOS', `Solo se permiten ${config.maxExternalSuppliers} usuarios externos`);
    } else supplier_id = null;
    const name = b.name !== undefined ? v.str(b.name, 'nombre', { max: 100 }) : u.name;
    let hash = u.password_hash;
    if (b.password) {
      const pw = v.str(b.password, 'contraseña', { min: 10, max: 100 });
      if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(422, 'VALIDACION', 'contraseña: debe combinar letras y números (mín. 10 caracteres)');
      hash = hashPassword(pw); changes.push('contraseña restablecida');
    }
    if (role !== u.role) changes.push(`rol ${u.role}→${role}`);
    if (active !== u.active) changes.push(active ? 'reactivado' : 'desactivado');
    if (name !== u.name) changes.push('nombre');
    run('UPDATE users SET name=?, role=?, active=?, supplier_id=?, password_hash=? WHERE id=?', name, role, active, supplier_id ? Number(supplier_id) : null, hash, u.id);
    ctxLog(ctx, 'MODIFICACION', 'usuario', u.id, `${u.email}: ${changes.join(', ') || 'sin cambios'}`);
    return get(`SELECT ${PUBLIC_USER} FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.id=?`, u.id);
  });

  // ---------- Matriz de permisos editable (PRD 3.3) ----------
  r.get('/api/permissions', auth, perm('permissions.manage', 'users.manage'), () => {
    const matrix = {};
    for (const role of Object.keys(ROLES)) matrix[role] = all('SELECT permission FROM role_permissions WHERE role=?', role).map((x) => x.permission);
    return {
      roles: Object.entries(ROLES).map(([key, x]) => ({ key, ...x })),
      catalog: Object.entries(PERMISSIONS).map(([key, x]) => ({ key, ...x })),
      matrix, protected: ADMIN_PROTECTED,
    };
  });

  r.put('/api/permissions', auth, perm('permissions.manage'), (ctx) => {
    const role = v.oneOf(ctx.body.role, 'rol', Object.keys(ROLES));
    const permission = v.oneOf(ctx.body.permission, 'permiso', Object.keys(PERMISSIONS));
    const granted = ctx.body.granted === true;
    if (role === 'admin' && !granted && ADMIN_PROTECTED.includes(permission))
      throw new HttpError(422, 'PERMISO_PROTEGIDO', 'Este permiso no puede revocarse al Administrador (evita bloquear el sistema).');
    if (role === 'proveedor' && granted && permission !== 'supplier.portal')
      throw new HttpError(422, 'PERMISO_PROTEGIDO', 'Los proveedores externos solo pueden acceder al portal de proveedores.');
    if (role !== 'proveedor' && role !== 'admin' && permission === 'supplier.portal' && granted)
      throw new HttpError(422, 'PERMISO_PROTEGIDO', 'El portal de proveedores es exclusivo de Proveedores y Admin.');
    const had = !!get('SELECT 1 x FROM role_permissions WHERE role=? AND permission=?', role, permission);
    if (had === granted) return { ok: true, changed: false };
    if (granted) run('INSERT INTO role_permissions (role, permission) VALUES (?,?)', role, permission);
    else run('DELETE FROM role_permissions WHERE role=? AND permission=?', role, permission);
    const detail = `${granted ? 'Otorgó' : 'Revocó'} «${PERMISSIONS[permission].label}» (${permission}) ${granted ? 'a' : 'de'} ${ROLES[role].label}`;
    ctxLog(ctx, 'MODIFICACION', 'permisos', `${role}:${permission}`, detail);
    notify({ level: 'warning', title: 'Permisos modificados', body: `${ctx.user.name}: ${detail}`, link: '/accesos' });
    detect();
    return { ok: true, changed: true };
  });

  // ---------- Bitácora de auditoría (PRD 3.4) ----------
  r.get('/api/audit', auth, perm('audit.view'), (ctx) => {
    const { action, role, entity, q, from, to, user } = ctx.query;
    const limit = Math.min(Number(ctx.query.limit) || 100, 500);
    const offset = Number(ctx.query.offset) || 0;
    const where = []; const p = [];
    if (action) { where.push('action = ?'); p.push(action); }
    if (role) { where.push('role = ?'); p.push(role); }
    if (entity) { where.push('entity = ?'); p.push(entity); }
    if (user) { where.push('user_name LIKE ?'); p.push(`%${user}%`); }
    if (from) { where.push('ts >= ?'); p.push(new Date(from).toISOString()); }
    if (to) { where.push('ts <= ?'); p.push(new Date(new Date(to).getTime() + 86400e3 - 1).toISOString()); }
    if (q) { where.push('(detail LIKE ? OR user_name LIKE ? OR entity_id LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return {
      events: all(`SELECT id,ts,user_id,user_name,role,action,entity,entity_id,detail,ip,device,SUBSTR(hash,1,12) hash FROM audit_log ${W} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset),
      total: get(`SELECT COUNT(*) n FROM audit_log ${W}`, ...p).n,
    };
  });

  r.get('/api/audit/verify', auth, perm('audit.view'), (ctx) => {
    const res = verifyChain();
    ctxLog(ctx, 'CLICK', 'auditoria', null, `Verificación de integridad de la bitácora: ${res.ok ? 'íntegra' : `ALTERADA en #${res.brokenAt}`}`);
    return res;
  });

  // Eventos de interfaz (navegación / clics relevantes) — PRD criterio 4: "cada clic o acción simulada".
  const UI_ACTIONS = ['NAVEGACION', 'CLICK'];
  r.post('/api/audit/ui-event', auth, (ctx) => {
    rateLimit(`ui:${ctx.user.id}`, 120, 60_000);
    const action = v.oneOf(ctx.body.action, 'acción', UI_ACTIONS);
    ctxLog(ctx, action, v.str(ctx.body.target, 'objetivo', { max: 60 }), null, v.str(ctx.body.detail, 'detalle', { optional: true, max: 200 }));
    return { ok: true };
  });

  // La bitácora no es editable: cualquier intento se rechaza, se registra y se notifica.
  const immutable = (ctx) => {
    logEvent({ user: ctx.user, action: 'ACCESO_DENEGADO', entity: 'auditoria', entityId: ctx.params.id,
      detail: `Intento de ${ctx.req.method === 'DELETE' ? 'eliminar' : 'modificar'} el registro #${ctx.params.id} de la bitácora`, ip: ctx.ip, device: ctx.device });
    notify({ level: 'critical', title: 'Intento de alterar la bitácora', body: `${ctx.user.name} (${ctx.user.role}) intentó ${ctx.req.method === 'DELETE' ? 'eliminar' : 'modificar'} el registro #${ctx.params.id}.`, link: '/auditoria' });
    detect();
    throw new HttpError(405, 'BITACORA_INMUTABLE', 'La bitácora de auditoría es inmutable: los registros no se pueden modificar ni eliminar. El intento fue registrado.', { role: ctx.user.role, action: 'alterar la bitácora de auditoría' });
  };
  r.delete('/api/audit/:id', auth, immutable);
  r.put('/api/audit/:id', auth, immutable);
  r.patch('/api/audit/:id', auth, immutable);

  // ---------- Auditor Inteligente (PRD 1.5.1) ----------
  r.get('/api/ai/anomalies', auth, perm('ai.view'), (ctx) => {
    const rows = listAnomalies({ status: ctx.query.status });
    return { anomalies: rows, summary: summarize(rows) };
  });

  r.post('/api/ai/scan', auth, perm('ai.scan'), (ctx) => {
    const t0 = Date.now();
    const created = detect();
    const rows = listAnomalies();
    const stats = {
      invoices: get('SELECT COUNT(*) n FROM invoices').n,
      supplier_invoices: get('SELECT COUNT(*) n FROM supplier_invoices').n,
      work_orders: get('SELECT COUNT(*) n FROM work_orders').n,
      audit_events: get('SELECT COUNT(*) n FROM audit_log').n,
    };
    ctxLog(ctx, 'ESCANEO_IA', 'anomalias', null, `Escaneo completo: ${stats.invoices} facturas, ${stats.audit_events} eventos → ${created.length} hallazgos nuevos`);
    const open = rows.filter((x) => x.status === 'abierta');
    return {
      duration_ms: Date.now() - t0, stats, new_count: created.length, anomalies: rows, summary: summarize(rows),
      flagged_invoice_ids: [...new Set(open.filter((x) => x.ref_type === 'invoice' && x.ref_id).map((x) => x.ref_id))],
    };
  });

  r.patch('/api/ai/anomalies/:id', auth, perm('ai.scan'), (ctx) => {
    const a = get('SELECT * FROM anomalies WHERE id=?', Number(ctx.params.id));
    if (!a) throw new HttpError(404, 'NO_ENCONTRADO', 'Alerta no encontrada');
    const status = v.oneOf(ctx.body.status, 'estado', ['abierta', 'revisada', 'descartada']);
    const note = v.str(ctx.body.note, 'nota', { optional: true, max: 300 });
    if (status === 'descartada' && !note) throw new HttpError(422, 'VALIDACION', 'nota: justifica por qué se descarta la alerta');
    run('UPDATE anomalies SET status=?, review_note=?, reviewed_by=? WHERE id=?', status, note, ctx.user.id, a.id);
    ctxLog(ctx, 'MODIFICACION', 'anomalia', a.id, `${a.title} → ${status}${note ? `: ${note}` : ''}`);
    return get('SELECT * FROM anomalies WHERE id=?', a.id);
  });

  // ---------- Contabilidad: NIIF 15, conciliación y libros (PRD 1.5.3) ----------
  r.get('/api/accounting/niif15', auth, perm('accounting.view'), () => {
    const { summary, rows } = niif15Report();
    return { summary, rows };
  });

  r.get('/api/accounting/summary', auth, perm('accounting.view'), () => {
    const sales = get("SELECT COALESCE(SUM(subtotal-discount),0) base, COALESCE(SUM(tax),0) iva, COALESCE(SUM(total),0) total, COUNT(*) n FROM invoices WHERE status!='anulada'");
    const collected = get("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM invoices WHERE status='pagada'");
    const receivable = get("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM invoices WHERE status='pendiente'");
    const voided = get("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM invoices WHERE status='anulada'");
    const purchases = get("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM supplier_invoices WHERE status IN ('aprobada','pagada')");
    const payable = get("SELECT COALESCE(SUM(amount),0) t, COUNT(*) n FROM supplier_invoices WHERE status='aprobada'");
    const paid = get("SELECT COALESCE(SUM(amount),0) t FROM supplier_invoices WHERE status='pagada'");
    const inventory = get("SELECT COALESCE(SUM(stock*cost),0) cost_value, COALESCE(SUM(stock*price),0) sale_value FROM products WHERE type!='servicio'");
    const ivaCredit = Math.round(purchases.total - purchases.total / (1 + config.taxRate));
    return {
      ventas: { ...sales, cobrado: collected, por_cobrar: receivable, anulado: voided },
      compras: { ...purchases, por_pagar: payable, pagado: paid.t, iva_credito: ivaCredit },
      iva: { debito: sales.iva, credito: ivaCredit, neto: sales.iva - ivaCredit },
      inventario: inventory,
      conciliacion: { ventas_total: sales.total, cobrado_mas_por_cobrar: collected.t + receivable.t, diferencia: sales.total - collected.t - receivable.t },
    };
  });

  r.get('/api/accounting/ledger', auth, perm('accounting.export'), (ctx) => {
    const type = v.oneOf(ctx.query.type, 'tipo', ['ventas', 'compras']);
    const esc = (x) => { const s = String(x ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    let header; let rows;
    if (type === 'ventas') {
      header = ['Fecha', 'Consecutivo', 'Tipo', 'Cliente', 'Subtotal', 'Descuento', 'IVA 13%', 'Total', 'Estado', 'Emitida por'];
      rows = all(`SELECT i.created_at,i.number,i.kind,c.name cn,i.subtotal,i.discount,i.tax,i.total,i.status,u.name un FROM invoices i
                  LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN users u ON u.id=i.created_by ORDER BY i.id`)
        .map((x) => [localParts(x.created_at).date, x.number, x.kind, x.cn || 'Contado', x.subtotal, x.discount, x.tax, x.total, x.status, x.un]);
    } else {
      header = ['Fecha emisión', 'Proveedor', 'Factura', 'Descripción', 'Monto', 'Estado', 'Entrega confirmada', 'Origen'];
      rows = all(`SELECT s.issue_date,p.name pn,s.number,s.description,s.amount,s.status,s.delivery_confirmed,s.source FROM supplier_invoices s JOIN suppliers p ON p.id=s.supplier_id ORDER BY s.issue_date,s.id`)
        .map((x) => [x.issue_date, x.pn, x.number, x.description, x.amount, x.status, x.delivery_confirmed ? 'Sí' : 'No', x.source]);
    }
    ctxLog(ctx, 'EXPORTACION', 'libro_contable', null, `Libro de ${type} exportado (${rows.length} filas)`);
    const csv = '﻿' + [header, ...rows].map((l) => l.map(esc).join(';')).join('\r\n');
    return new Raw(csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="motofix_libro_${type}_${new Date().toISOString().slice(0, 10)}.csv"` });
  });
}

function summarize(rows) {
  const open = rows.filter((x) => x.status === 'abierta');
  return { open: open.length, alta: open.filter((x) => x.severity === 'alta').length, media: open.filter((x) => x.severity === 'media').length, baja: open.filter((x) => x.severity === 'baja').length, total: rows.length };
}
