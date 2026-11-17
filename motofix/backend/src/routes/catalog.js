import { all, get, run, tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { auth, perm, can } from '../auth.js';
import { ctxLog } from '../audit.js';
import { crc } from '../lib/time.js';

export function catalogRoutes(r) {
  // ---------- Inventario / catálogo (PRD 1.4) ----------
  r.get('/api/products', auth, perm('inventory.view'), (ctx) => {
    const { q, type, low } = ctx.query;
    const where = ['1=1']; const p = [];
    if (q) { where.push('(name LIKE ? OR sku LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
    if (type) { where.push('type = ?'); p.push(type); }
    if (low === '1') where.push("type != 'servicio' AND stock <= min_stock");
    const showCost = can(ctx, 'inventory.view_cost');
    const rows = all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY type, name`, ...p);
    return { products: rows.map((x) => { if (!showCost) delete x.cost; return x; }), showCost };
  });

  const readProduct = (b, existing) => ({
    sku: v.str(b.sku ?? existing?.sku, 'SKU', { max: 30 }).toUpperCase(),
    name: v.str(b.name ?? existing?.name, 'nombre', { max: 120 }),
    type: v.oneOf(b.type ?? existing?.type, 'tipo', ['repuesto', 'insumo', 'servicio']),
    price: v.num(b.price ?? existing?.price, 'precio', { int: true, min: 0, max: 100_000_000 }),
    cost: v.num(b.cost ?? existing?.cost ?? 0, 'costo', { int: true, min: 0, max: 100_000_000 }),
    min_stock: v.num(b.min_stock ?? existing?.min_stock ?? 0, 'stock mínimo', { int: true, min: 0, max: 100000 }),
  });

  r.post('/api/products', auth, perm('inventory.edit'), (ctx) => {
    const p = readProduct(ctx.body);
    if (get('SELECT 1 x FROM products WHERE sku=?', p.sku)) throw new HttpError(409, 'SKU_DUPLICADO', `Ya existe un producto con SKU ${p.sku}`);
    const stock = p.type === 'servicio' ? 0 : v.num(ctx.body.stock ?? 0, 'stock inicial', { int: true, min: 0, max: 100000 });
    const res = run('INSERT INTO products (sku,name,type,price,cost,stock,min_stock,active) VALUES (?,?,?,?,?,?,?,1)', p.sku, p.name, p.type, p.price, p.cost, stock, p.min_stock);
    const id = Number(res.lastInsertRowid);
    if (stock > 0) run("INSERT INTO stock_movements (product_id,qty,reason,note,user_id,created_at) VALUES (?,?,'ajuste','Stock inicial',?,?)", id, stock, ctx.user.id, new Date().toISOString());
    ctxLog(ctx, 'CREACION', 'producto', id, `${p.sku} · ${p.name} · ${crc(p.price)}`);
    ctx.status = 201;
    return get('SELECT * FROM products WHERE id=?', id);
  });

  r.put('/api/products/:id', auth, perm('inventory.edit'), (ctx) => {
    const cur = get('SELECT * FROM products WHERE id=?', Number(ctx.params.id));
    if (!cur) throw new HttpError(404, 'NO_ENCONTRADO', 'Producto no encontrado');
    const p = readProduct(ctx.body, cur);
    if (p.sku !== cur.sku && get('SELECT 1 x FROM products WHERE sku=?', p.sku)) throw new HttpError(409, 'SKU_DUPLICADO', `Ya existe un producto con SKU ${p.sku}`);
    const active = ctx.body.active === undefined ? cur.active : ctx.body.active ? 1 : 0;
    run('UPDATE products SET sku=?,name=?,type=?,price=?,cost=?,min_stock=?,active=? WHERE id=?', p.sku, p.name, p.type, p.price, p.cost, p.min_stock, active, cur.id);
    const changes = [];
    if (cur.price !== p.price) changes.push(`precio ${crc(cur.price)}→${crc(p.price)}`);
    if (cur.name !== p.name) changes.push('nombre');
    if (cur.active !== active) changes.push(active ? 'reactivado' : 'desactivado');
    ctxLog(ctx, 'MODIFICACION', 'producto', cur.id, `${cur.sku}: ${changes.join(', ') || 'datos'}`);
    return get('SELECT * FROM products WHERE id=?', cur.id);
  });

  r.post('/api/products/:id/adjust', auth, perm('inventory.adjust'), (ctx) => {
    const p = get('SELECT * FROM products WHERE id=?', Number(ctx.params.id));
    if (!p) throw new HttpError(404, 'NO_ENCONTRADO', 'Producto no encontrado');
    if (p.type === 'servicio') throw new HttpError(422, 'VALIDACION', 'Los servicios no manejan stock');
    const delta = v.num(ctx.body.delta, 'ajuste', { int: true, min: -100000, max: 100000 });
    if (delta === 0) throw new HttpError(422, 'VALIDACION', 'ajuste: no puede ser 0');
    const note = v.str(ctx.body.note, 'motivo', { min: 5, max: 200 });
    if (p.stock + delta < 0) throw new HttpError(422, 'STOCK_INSUFICIENTE', 'El ajuste dejaría el stock en negativo');
    tx(() => {
      run('UPDATE products SET stock = stock + ? WHERE id=?', delta, p.id);
      run("INSERT INTO stock_movements (product_id,qty,reason,note,user_id,created_at) VALUES (?,?,'ajuste',?,?,?)", p.id, delta, note, ctx.user.id, new Date().toISOString());
    });
    ctxLog(ctx, 'MODIFICACION', 'inventario', p.id, `Ajuste manual ${delta > 0 ? '+' : ''}${delta} de ${p.name} (${p.stock}→${p.stock + delta}). ${note}`);
    return get('SELECT * FROM products WHERE id=?', p.id);
  });

  r.get('/api/inventory/movements', auth, perm('inventory.view'), (ctx) => {
    const rows = all(`SELECT m.*, p.name product_name, p.sku, u.name user_name FROM stock_movements m JOIN products p ON p.id=m.product_id
                      LEFT JOIN users u ON u.id=m.user_id ${ctx.query.product_id ? 'WHERE m.product_id = ?' : ''} ORDER BY m.id DESC LIMIT 150`, ...(ctx.query.product_id ? [Number(ctx.query.product_id)] : []));
    return { movements: rows };
  });

  // ---------- Clientes ----------
  r.get('/api/customers', auth, perm('customers.view'), (ctx) => {
    const q = ctx.query.q;
    return { customers: all(`SELECT * FROM customers ${q ? 'WHERE name LIKE ? OR id_number LIKE ? OR phone LIKE ?' : ''} ORDER BY name LIMIT 300`, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])) };
  });
  const readCustomer = (b) => ({
    name: v.str(b.name, 'nombre', { max: 120 }), id_number: v.str(b.id_number, 'cédula', { optional: true, max: 30 }),
    phone: v.str(b.phone, 'teléfono', { optional: true, max: 30 }), email: b.email ? v.email(b.email) : null,
  });
  r.post('/api/customers', auth, perm('customers.manage'), (ctx) => {
    const c = readCustomer(ctx.body);
    const res = run('INSERT INTO customers (name,id_number,phone,email,created_at) VALUES (?,?,?,?,?)', c.name, c.id_number, c.phone, c.email, new Date().toISOString());
    ctxLog(ctx, 'CREACION', 'cliente', Number(res.lastInsertRowid), c.name);
    ctx.status = 201;
    return get('SELECT * FROM customers WHERE id=?', Number(res.lastInsertRowid));
  });
  r.put('/api/customers/:id', auth, perm('customers.manage'), (ctx) => {
    const cur = get('SELECT * FROM customers WHERE id=?', Number(ctx.params.id));
    if (!cur) throw new HttpError(404, 'NO_ENCONTRADO', 'Cliente no encontrado');
    const c = readCustomer(ctx.body);
    run('UPDATE customers SET name=?,id_number=?,phone=?,email=? WHERE id=?', c.name, c.id_number, c.phone, c.email, cur.id);
    ctxLog(ctx, 'MODIFICACION', 'cliente', cur.id, c.name);
    return get('SELECT * FROM customers WHERE id=?', cur.id);
  });

  // ---------- Órdenes de trabajo ----------
  const loadWO = (id) => {
    const w = get(`SELECT w.*, c.name customer_name, i.number invoice_number, i.id invoice_id FROM work_orders w JOIN customers c ON c.id=w.customer_id
                   LEFT JOIN invoices i ON i.work_order_id=w.id AND i.status!='anulada' WHERE w.id=?`, id);
    if (!w) return null;
    w.parts = all('SELECT wp.*, p.name, p.sku FROM work_order_parts wp JOIN products p ON p.id=wp.product_id WHERE wp.work_order_id=?', id);
    w.expected = w.labor_amount + w.parts.reduce((s, x) => s + x.qty * x.unit_price, 0);
    return w;
  };

  r.get('/api/workorders', auth, perm('workorders.view'), (ctx) => {
    const ids = all(`SELECT id FROM work_orders ${ctx.query.status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 150`, ...(ctx.query.status ? [ctx.query.status] : []));
    return { workorders: ids.map((x) => loadWO(x.id)) };
  });

  const readParts = (list) => v.array(list ?? [], 'repuestos', { max: 30 }).map((x, k) => {
    const p = get("SELECT * FROM products WHERE id=? AND active=1 AND type != 'servicio'", Number(x.product_id));
    if (!p) throw new HttpError(404, 'NO_ENCONTRADO', `Repuesto ${x.product_id} no existe`);
    return { product_id: p.id, qty: v.num(x.qty, `repuesto ${k + 1} cantidad`, { int: true, min: 1, max: 999 }), unit_price: p.price };
  });

  r.post('/api/workorders', auth, perm('workorders.create'), (ctx) => {
    const b = ctx.body;
    const customer = get('SELECT id FROM customers WHERE id=?', Number(b.customer_id));
    if (!customer) throw new HttpError(404, 'NO_ENCONTRADO', 'Cliente no encontrado');
    const motorcycle = v.str(b.motorcycle, 'motocicleta', { max: 80 });
    const description = v.str(b.description, 'descripción del trabajo', { min: 5, max: 400 });
    const labor = v.num(b.labor_amount ?? 0, 'mano de obra', { int: true, min: 0, max: 50_000_000 });
    const parts = readParts(b.parts);
    const id = tx(() => {
      const n = (get('SELECT MAX(CAST(SUBSTR(number,4) AS INTEGER)) m FROM work_orders').m || 0) + 1;
      const res = run("INSERT INTO work_orders (number,customer_id,motorcycle,plate,description,status,labor_amount,created_by,created_at) VALUES (?,?,?,?,?,'abierta',?,?,?)",
        `OT-${String(n).padStart(5, '0')}`, customer.id, motorcycle, v.str(b.plate, 'placa', { optional: true, max: 12 }), description, labor, ctx.user.id, new Date().toISOString());
      const wid = Number(res.lastInsertRowid);
      for (const p of parts) run('INSERT INTO work_order_parts (work_order_id,product_id,qty,unit_price) VALUES (?,?,?,?)', wid, p.product_id, p.qty, p.unit_price);
      return wid;
    });
    const w = loadWO(id);
    ctxLog(ctx, 'CREACION', 'orden_trabajo', id, `${w.number} · ${w.motorcycle} · ${w.customer_name}`);
    ctx.status = 201;
    return w;
  });

  r.patch('/api/workorders/:id', auth, perm('workorders.update'), (ctx) => {
    const w = get('SELECT * FROM work_orders WHERE id=?', Number(ctx.params.id));
    if (!w) throw new HttpError(404, 'NO_ENCONTRADO', 'Orden no encontrada');
    if (w.status === 'facturada' || w.status === 'cancelada') throw new HttpError(409, 'ESTADO_INVALIDO', `La orden está ${w.status} y no admite cambios`);
    const b = ctx.body;
    const notes = [];
    tx(() => {
      if (b.parts !== undefined) {
        const parts = readParts(b.parts);
        run('DELETE FROM work_order_parts WHERE work_order_id=?', w.id);
        for (const p of parts) run('INSERT INTO work_order_parts (work_order_id,product_id,qty,unit_price) VALUES (?,?,?,?)', w.id, p.product_id, p.qty, p.unit_price);
        notes.push('repuestos usados actualizados');
      }
      if (b.labor_amount !== undefined) {
        run('UPDATE work_orders SET labor_amount=? WHERE id=?', v.num(b.labor_amount, 'mano de obra', { int: true, min: 0, max: 50_000_000 }), w.id);
        notes.push('mano de obra actualizada');
      }
      if (b.status !== undefined) {
        const next = v.oneOf(b.status, 'estado', ['en_proceso', 'completada', 'cancelada']);
        const allowed = { abierta: ['en_proceso', 'completada', 'cancelada'], en_proceso: ['completada', 'cancelada'], completada: ['cancelada'] };
        if (!allowed[w.status]?.includes(next)) throw new HttpError(409, 'ESTADO_INVALIDO', `No se puede pasar de ${w.status} a ${next}`);
        run('UPDATE work_orders SET status=?, completed_at=? WHERE id=?', next, next === 'completada' ? new Date().toISOString() : w.completed_at, w.id);
        notes.push(`estado ${w.status} → ${next}`);
      }
    });
    ctxLog(ctx, 'MODIFICACION', 'orden_trabajo', w.id, `${w.number}: ${notes.join(', ') || 'sin cambios'}`);
    return loadWO(w.id);
  });
}
