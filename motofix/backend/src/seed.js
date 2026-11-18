// Repositorio de Mock Data Sintética (PRD 1.6.3).
// Genera ~60 días de operación ficticia de un taller en Costa Rica (₡) pasando por los MISMOS servicios
// que usa la API (hash anti-duplicación, stock, bitácora encadenada), y planta anomalías conocidas para
// demostrar el Auditor Inteligente, el monitor NIIF 15 y los controles de acceso. Todo es ficticio.
import { fileURLToPath } from 'node:url';
import { all, get, run, resetData } from './db.js';
import { config } from './config.js';
import { hashPassword } from './lib/password.js';
import { DEFAULT_MATRIX } from './permissions.js';
import { logEvent } from './audit.js';
import { notify } from './auth.js';
import { localParts } from './lib/time.js';
import { createInvoice, voidInvoice, fmtNumber } from './services/invoices.js';
import { createSupplierInvoice } from './routes/suppliers.js';
import { detect } from './anomaly.js';
import { HttpError } from './lib/http.js';
import { ensureApDefaults } from './services/ap.js';
import { seedAp } from './services/ap-seed.js';

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function seed({ reset = false } = {}) {
  if (reset) resetData();
  ensureApDefaults();
  const rng = mulberry32(20261026);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const pickN = (arr, n) => { const c = [...arr]; const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rng() * c.length), 1)[0]); return out; };

  const NOW = new Date();
  const todayStr = localParts(NOW.toISOString()).date;
  const dayStr = (d) => new Date(Date.parse(`${todayStr}T00:00:00Z`) - d * 86400e3).toISOString().slice(0, 10);
  const dowOf = (d) => new Date(Date.parse(`${dayStr(d)}T00:00:00Z`)).getUTCDay();
  const at = (d, h, m = 0, s = 0) => new Date(Date.parse(`${dayStr(d)}T00:00:00Z`) - config.tzOffsetHours * 3600e3 + ((h * 60 + m) * 60 + s) * 1000);
  const workday = (d) => { while (dowOf(d) === 0) d++; return d; };
  const iso = (d) => d.toISOString();

  // ---------- Proveedores, usuarios y permisos ----------
  const suppliers = [
    ['Repuestos del Pacífico S.A.', '3-101-884211', 'ventas@repuestospacifico.example', '2200-1101'],
    ['Lubricantes y Filtros Altura S.A.', '3-101-771903', 'facturas@lubaltura.example', '2200-2202'],
    ['Frenos y Llantas Moto Center S.A.', '3-101-905512', 'cobros@motocenter.example', '2200-3303'],
  ];
  for (const [name, tax, email, phone] of suppliers) run('INSERT INTO suppliers (name,tax_id,contact_email,phone,active) VALUES (?,?,?,?,1)', name, tax, email, phone);

  const pw = hashPassword(config.demoPassword);
  const people = [
    ['admin', 'Mariana Solís', 'admin', null, '192.168.10.2', 'Chrome 130 · Windows'],
    ['gerente', 'Carlos Jiménez', 'gerente', null, '192.168.10.5', 'Safari 18 · macOS'],
    ['contador', 'Lucía Fernández', 'contador', null, '192.168.10.30', 'Chrome 130 · macOS'],
    ['auditor', 'Patricia Brenes', 'auditor', null, '192.168.10.50', 'Edge 130 · Windows'],
    ['recepcionista', 'Andrés Mora', 'recepcionista', null, '192.168.10.21', 'Chrome 130 · Windows'],
    ['recepcionista2', 'Sofía Vargas', 'recepcionista', null, '192.168.10.22', 'Edge 129 · Windows'],
    ['ventas', 'Diego Rojas', 'ventas', null, '192.168.10.40', 'Chrome 130 · Android'],
    ['proveedor1', 'Jorge Quesada (Repuestos del Pacífico)', 'proveedor', 1, '190.113.44.18', 'Chrome 130 · Windows'],
    ['proveedor2', 'Karen Alfaro (Lubricantes Altura)', 'proveedor', 2, '186.15.201.77', 'Firefox 131 · Windows'],
    ['proveedor3', 'Esteban Ureña (Moto Center)', 'proveedor', 3, '201.200.9.130', 'Safari 18 · iOS'],
  ];
  const U = {};
  for (const [key, name, role, supplier_id, ip, device] of people) {
    const email = `${key.replace('recepcionista2', 'recepcion2')}@motofix.demo`;
    const demo = key === 'recepcionista2' ? null : key;
    const r = run('INSERT INTO users (name,email,password_hash,role,supplier_id,demo_key,active,created_at) VALUES (?,?,?,?,?,?,1,?)', name, email, pw, role, supplier_id, demo, iso(at(62, 9)));
    U[key] = { id: Number(r.lastInsertRowid), name, role, supplier_id, ip, device };
  }
  for (const [role, perms] of Object.entries(DEFAULT_MATRIX)) for (const p of perms) run('INSERT INTO role_permissions (role, permission) VALUES (?,?)', role, p);
  const logAs = (key, action, entity, entityId, detail, when) => logEvent({ user: U[key], action, entity, entityId, detail, ip: U[key].ip, device: U[key].device, ts: iso(when) });

  // ---------- Catálogo ----------
  const catalog = [
    ['SRV-001', 'Cambio de aceite y filtro (mano de obra)', 'servicio', 8000, 0, 0, 0],
    ['SRV-002', 'Afinamiento mayor', 'servicio', 35000, 0, 0, 0],
    ['SRV-003', 'Revisión y ajuste de frenos', 'servicio', 12000, 0, 0, 0],
    ['SRV-004', 'Cambio de llanta (mano de obra)', 'servicio', 6500, 0, 0, 0],
    ['SRV-005', 'Diagnóstico electrónico', 'servicio', 15000, 0, 0, 0],
    ['SRV-006', 'Ajuste y lubricación de cadena', 'servicio', 9000, 0, 0, 0],
    ['SRV-007', 'Instalación de kit de arrastre', 'servicio', 18000, 0, 0, 0],
    ['SRV-008', 'Lavado y engrase general', 'servicio', 7000, 0, 0, 0],
    ['REP-101', 'Pastillas de freno delanteras', 'repuesto', 9500, 5200, 120, 12],
    ['REP-102', 'Pastillas de freno traseras', 'repuesto', 8200, 4500, 110, 12],
    ['REP-103', 'Kit de arrastre (cadena + piñones)', 'repuesto', 38000, 24000, 60, 6],
    ['REP-104', 'Llanta trasera 130/70-17', 'repuesto', 62000, 44000, 40, 5],
    ['REP-105', 'Llanta delantera 110/70-17', 'repuesto', 54000, 38000, 40, 5],
    ['REP-106', 'Batería 12V 9Ah', 'repuesto', 32000, 21000, 50, 6],
    ['REP-107', 'Bujía de iridio', 'repuesto', 7800, 4100, 150, 20],
    ['REP-108', 'Filtro de aire', 'repuesto', 6500, 3200, 130, 15],
    ['REP-109', 'Filtro de aceite', 'repuesto', 3800, 1900, 220, 30],
    ['REP-110', 'Cable de acelerador', 'repuesto', 4500, 2200, 90, 10],
    ['REP-111', 'Cable de embrague', 'repuesto', 4800, 2400, 90, 10],
    ['REP-112', 'Espejos retrovisores (par)', 'repuesto', 11500, 6500, 60, 8],
    ['REP-113', 'Manigueta de freno', 'repuesto', 5500, 2800, 70, 8],
    ['REP-114', 'Amortiguador trasero', 'repuesto', 48000, 31000, 30, 4],
    ['REP-115', 'Faro delantero LED', 'repuesto', 29000, 17500, 35, 4],
    ['REP-116', 'Disco de freno delantero', 'repuesto', 36000, 23000, 35, 4],
    ['REP-117', 'Kit de embrague', 'repuesto', 45000, 28500, 30, 4],
    ['REP-118', 'Cuerpo de aceleración', 'repuesto', 85000, 58000, 15, 3],
    ['REP-119', 'Motor de arranque', 'repuesto', 72000, 49000, 15, 3],
    ['REP-120', 'Regulador de voltaje', 'repuesto', 18500, 11000, 40, 5],
    ['INS-201', 'Aceite 10W-40 sintético (1 L)', 'insumo', 9800, 6200, 500, 40],
    ['INS-202', 'Aceite 20W-50 mineral (1 L)', 'insumo', 6500, 4000, 500, 40],
    ['INS-203', 'Líquido de frenos DOT 4', 'insumo', 5200, 3000, 200, 20],
    ['INS-204', 'Grasa para cadena (spray)', 'insumo', 6900, 4000, 200, 20],
    ['INS-205', 'Refrigerante (1 L)', 'insumo', 4800, 2700, 200, 20],
    ['INS-206', 'Limpiador de frenos', 'insumo', 4200, 2300, 200, 20],
    ['INS-207', 'Sellador de empaques', 'insumo', 3900, 2000, 150, 15],
  ];
  for (const [sku, name, type, price, cost, stock0, min] of catalog) {
    const stock = stock0 * 3; // inventario inicial holgado: el histórico simulado consume ~60 días de ventas
    const r = run('INSERT INTO products (sku,name,type,price,cost,stock,min_stock,active) VALUES (?,?,?,?,?,?,?,1)', sku, name, type, price, cost, stock, min);
    if (stock) run("INSERT INTO stock_movements (product_id,qty,reason,note,user_id,created_at) VALUES (?,?,'ajuste','Inventario inicial',?,?)", Number(r.lastInsertRowid), stock, U.gerente.id, iso(at(62, 10)));
  }
  const prod = Object.fromEntries(all('SELECT * FROM products').map((p) => [p.sku, p]));
  const services = all("SELECT * FROM products WHERE type='servicio'");
  const goods = all("SELECT * FROM products WHERE type!='servicio'");

  // ---------- Clientes ----------
  const first = ['José', 'María', 'Luis', 'Ana', 'Daniel', 'Karla', 'Mauricio', 'Priscilla', 'Roberto', 'Gabriela', 'Esteban', 'Valeria', 'Fernando', 'Daniela', 'Alonso', 'Natalia', 'Javier', 'Melissa', 'Óscar', 'Tatiana'];
  const last = ['Vargas', 'Rojas', 'Mora', 'Solano', 'Campos', 'Araya', 'Chaves', 'Quesada', 'Jiménez', 'Salazar', 'Brenes', 'Cordero', 'Barrantes', 'Alvarado', 'Hernández', 'Zúñiga', 'Ulate', 'Segura'];
  const customers = [];
  for (let i = 0; i < 36; i++) {
    const name = `${first[i % first.length]} ${last[(i * 7 + 3) % last.length]} ${last[(i * 5 + 11) % last.length]}`;
    const r = run('INSERT INTO customers (name,id_number,phone,email,created_at) VALUES (?,?,?,?,?)', name, `${ri(1, 7)}-0${ri(100, 999)}-0${ri(100, 999)}`, `${pick(['8', '6', '7'])}${ri(100, 999)}-${ri(1000, 9999)}`, rng() < 0.4 ? `cliente${i + 1}@correo.example` : null, iso(at(ri(30, 62), ri(8, 16))));
    customers.push({ id: Number(r.lastInsertRowid), name });
  }
  const motos = ['Honda CB190R', 'Yamaha FZ 150', 'Suzuki GN125', 'Kawasaki Ninja 400', 'Bajaj Pulsar NS200', 'Honda XR150L', 'Yamaha XTZ 125', 'KTM Duke 200', 'Honda Wave 110', 'Suzuki DR650'];
  const plate = () => `MOT-${ri(100, 999)}`;

  // ---------- Helpers de dominio ----------
  const createWO = (cust, spec, when, byKey) => {
    const r = run("INSERT INTO work_orders (number,customer_id,motorcycle,plate,description,status,labor_amount,created_by,created_at) VALUES (?,?,?,?,?,'abierta',?,?,?)",
      `OT-${String((get('SELECT COUNT(*) n FROM work_orders').n || 0) + 1).padStart(5, '0')}`, cust.id, spec.moto, plate(), spec.desc, spec.labor, U[byKey].id, iso(when));
    const id = Number(r.lastInsertRowid);
    for (const p of spec.parts) run('INSERT INTO work_order_parts (work_order_id,product_id,qty,unit_price) VALUES (?,?,?,?)', id, p.product.id, p.qty, p.product.price);
    const wo = get('SELECT * FROM work_orders WHERE id=?', id);
    logAs(byKey, 'CREACION', 'orden_trabajo', id, `${wo.number} · ${spec.moto} · ${cust.name}`, when);
    return wo;
  };
  const completeWO = (wo, when, byKey) => {
    run("UPDATE work_orders SET status='completada', completed_at=? WHERE id=?", iso(when), wo.id);
    logAs(byKey, 'MODIFICACION', 'orden_trabajo', wo.id, `${wo.number}: estado abierta → completada`, when);
  };
  const actorFor = (key) => U[key];
  const invoice = (input, key, when, extra = {}) =>
    createInvoice(input, actorFor(key), { ip: U[key].ip, device: U[key].device, now: when, skipDetect: true, ...extra });
  const nextNum = () => (get("SELECT MAX(CAST(SUBSTR(number,3) AS INTEGER)) m FROM invoices").m || 0) + 1;
  const lines = (list) => list.map((x) => ({ product_id: x.product.id, qty: x.qty }));
  const svcLines = (ss) => ss.map((s) => ({ product: s, qty: 1 }));

  const seenSig = new Set();
  const sigOf = (d, cust, items) => `${d}|${cust?.id || 0}|${items.map((i) => `${i.product.id}x${i.qty}`).sort().join(',')}`;

  // ---------- Escenarios plantados (offset en días atrás) ----------
  const planted = new Map();
  const plant = (d, t, fn) => { if (!planted.has(d)) planted.set(d, []); planted.get(d).push({ t, fn }); };
  // Orden de trabajo planificada: cada paso (crear / completar / facturar) se agenda en su propia hora para mantener la bitácora cronológica.
  const plantWO = (d, { cust, moto, desc, labor, parts, c, done, by, inv, after }) => {
    let wo;
    plant(d, at(d, ...c), () => { wo = createWO(cust, { moto, desc, labor, parts }, at(d, ...c), by); });
    plant(d, at(d, ...done), () => completeWO(wo, at(d, ...done), by));
    if (inv) plant(d, at(d, ...inv.t), () => { const out = invoice(inv.input(wo), inv.by || by, at(d, ...inv.t), inv.opts || {}); if (after) after(wo, out); });
  };
  const sundayOffset = (() => { let d = 10; while (dowOf(d) !== 0) d++; return d; })();
  let gapDay = workday(14);

  // P1 · Factura duplicada (+ intento bloqueado por el validador)
  { const d = workday(2); const cust = customers[5]; const it = [{ product: prod['REP-107'], qty: 2 }, { product: prod['INS-201'], qty: 2 }, ...svcLines([prod['SRV-002']])];
    let orig;
    plant(d, at(d, 10, 12), () => { orig = invoice({ kind: 'venta', customer_id: cust.id, items: lines(it), paid: false }, 'recepcionista', at(d, 10, 12)); });
    plant(d, at(d, 10, 19), () => { // el "duplicado" se cuela evadiendo el control (inserción directa), p. ej. doble clic con reintento
      const t = at(d, 10, 19); const src = get('SELECT * FROM invoices WHERE id=?', orig.id);
      const n = fmtNumber(nextNum());
      const r = run(`INSERT INTO invoices (number,kind,customer_id,work_order_id,subtotal,discount,tax,total,status,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        n, src.kind, src.customer_id, null, src.subtotal, src.discount, src.tax, src.total, 'pendiente', src.content_hash, U.recepcionista.id, iso(t));
      for (const x of all('SELECT * FROM invoice_items WHERE invoice_id=?', orig.id)) run('INSERT INTO invoice_items (invoice_id,product_id,description,qty,unit_price,line_total) VALUES (?,?,?,?,?,?)', Number(r.lastInsertRowid), x.product_id, x.description, x.qty, x.unit_price, x.line_total);
      logAs('recepcionista', 'CREACION', 'factura', Number(r.lastInsertRowid), `${n} · ₡${src.total.toLocaleString('es-CR')}`, t);
    });
    plant(d, at(d, 10, 31), () => { try { invoice({ kind: 'venta', customer_id: cust.id, items: lines(it) }, 'recepcionista2', at(d, 10, 31)); } catch (e) { if (!(e instanceof HttpError)) throw e; } });
  }
  // P2 · Monto atípico (motor completo) dentro de horario
  { const d = workday(6); plant(d, at(d, 14, 20), () => invoice({ kind: 'venta', customer_id: customers[11].id, notes: 'Pago por transferencia', items: [{ description: 'Motor completo reconstruido (Yamaha FZ 150)', qty: 1, unit_price: 1850000 }] }, 'recepcionista', at(d, 14, 20))); }
  // P3 · Factura en domingo de noche
  plant(sundayOffset, at(sundayOffset, 22, 15), () => invoice({ kind: 'venta', items: lines([{ product: prod['REP-111'], qty: 1 }, { product: prod['INS-204'], qty: 1 }]), paid: true }, 'recepcionista2', at(sundayOffset, 22, 15)));
  // P5 · Descuento del 35% aprobado por Gerente
  { const d = workday(11); const ss = svcLines([prod['SRV-002'], prod['SRV-007']]); const ps = [{ product: prod['REP-103'], qty: 1 }];
    plantWO(d, { cust: customers[20], moto: 'Honda CB190R', desc: 'Afinamiento y cambio de kit de arrastre', labor: 53000, parts: ps, c: [9, 5], done: [11, 20], by: 'recepcionista',
      inv: { t: [11, 40], by: 'gerente', input: (wo) => ({ kind: 'servicio', work_order_id: wo.id, discount_pct: 35, items: lines([...ss, ...ps]) }), opts: { discountApprovedBy: U.gerente.id } } }); }
  // P6 · Descuento 12% SIN aprobación registrada (control evadido)
  { const d = workday(4); const ps = [{ product: prod['REP-116'], qty: 1 }]; const ss = svcLines([prod['SRV-003']]);
    plantWO(d, { cust: customers[8], moto: 'Yamaha FZ 150', desc: 'Cambio de disco de freno', labor: 12000, parts: ps, c: [13, 10], done: [15, 40], by: 'recepcionista2',
      inv: { t: [16, 5], input: (wo) => ({ kind: 'servicio', work_order_id: wo.id, discount_pct: 12, items: lines([...ss, ...ps]) }), opts: { discountApprovedBy: null } } }); }
  // P7 · Ráfaga: 6 facturas en 8 minutos
  { const d = workday(3); const combos = [['REP-109'], ['REP-107'], ['INS-203'], ['REP-110'], ['INS-205'], ['REP-108']];
    combos.forEach((c, k) => { const m = 2 + k + (k > 3 ? 1 : 0); plant(d, at(d, 15, m), () => invoice({ kind: 'venta', items: lines(c.map((x) => ({ product: prod[x], qty: k + 1 }))), paid: true }, 'recepcionista2', at(d, 15, m))); }); }
  // P8 · Órdenes completadas sin facturar (obligación cumplida, ingreso no reconocido)
  { const dA = workday(9); plantWO(dA, { cust: customers[14], moto: 'Suzuki GN125', desc: 'Cambio de embrague completo', labor: 18000, parts: [{ product: prod['REP-117'], qty: 1 }], c: [8, 30], done: [10, 0], by: 'recepcionista' });
    const dB = workday(4); plantWO(dB, { cust: customers[22], moto: 'Honda XR150L', desc: 'Cambio de amortiguador trasero', labor: 18000, parts: [{ product: prod['REP-114'], qty: 1 }], c: [9, 30], done: [12, 0], by: 'recepcionista' }); }
  // P9 · Repuesto usado pero no facturado (fuga de ingresos)
  { const d = workday(7); const ps = [{ product: prod['REP-101'], qty: 1 }, { product: prod['REP-103'], qty: 1 }];
    plantWO(d, { cust: customers[3], moto: 'Kawasaki Ninja 400', desc: 'Frenos y kit de arrastre', labor: 18000, parts: ps, c: [10, 10], done: [15, 5], by: 'recepcionista',
      inv: { t: [15, 30], input: (wo) => ({ kind: 'servicio', work_order_id: wo.id, items: lines([...svcLines([prod['SRV-007']]), { product: prod['REP-101'], qty: 1 }]) }) } }); }
  // P9b · Repuesto facturado de más (sobrefacturación)
  { const d = workday(5); const ps = [{ product: prod['INS-201'], qty: 2 }];
    plantWO(d, { cust: customers[17], moto: 'Honda Wave 110', desc: 'Cambio de aceite', labor: 8000, parts: ps, c: [9, 50], done: [12, 15], by: 'recepcionista2',
      inv: { t: [12, 40], input: (wo) => ({ kind: 'servicio', work_order_id: wo.id, items: lines([...svcLines([prod['SRV-001']]), { product: prod['INS-201'], qty: 4 }]) }) } }); }
  // P10 · Factura emitida y fecha de cumplimiento de la orden alterada a posteriori (ingreso prematuro)
  { const d = workday(8); const ps = [{ product: prod['REP-115'], qty: 1 }];
    plantWO(d, { cust: customers[9], moto: 'KTM Duke 200', desc: 'Cambio de faro LED', labor: 15000, parts: ps, c: [9, 0], done: [10, 50], by: 'recepcionista',
      inv: { t: [11, 10], input: (wo) => ({ kind: 'servicio', work_order_id: wo.id, items: lines([...svcLines([prod['SRV-005']]), ...ps]) }) },
      after: (wo) => run('UPDATE work_orders SET completed_at=? WHERE id=?', iso(at(d, 14, 30)), wo.id) }); }
  // P11 · Cambios de permisos de madrugada (registrados; la matriz vigente no cambia)
  { const d = workday(5);
    plant(d, at(d, 2, 13), () => logEvent({ user: U.admin, action: 'MODIFICACION', entity: 'permisos', entityId: 'recepcionista:invoices.void', detail: 'Otorgó «Anular facturas directamente» (invoices.void) a Recepcionista', ip: '10.8.0.45', device: 'Firefox · Linux', ts: iso(at(d, 2, 13)) }));
    plant(d, at(d, 2, 19), () => logEvent({ user: U.admin, action: 'MODIFICACION', entity: 'permisos', entityId: 'recepcionista:invoices.void', detail: 'Revocó «Anular facturas directamente» (invoices.void) de Recepcionista', ip: '10.8.0.45', device: 'Firefox · Linux', ts: iso(at(d, 2, 19)) })); }
  // P12 · Recepcionista intentando anular facturas (acciones bloqueadas)
  { const d = workday(1);
    [[16, 41, 6], [16, 43, 6], [16, 52, 9]].forEach(([h, m, id]) => plant(d, at(d, h, m), () => {
      logAs('recepcionista', 'ACCESO_DENEGADO', 'permiso', 'invoices.void', `Intentó: Anular facturas directamente (POST /api/invoices/${id}/void)`, at(d, h, m));
      notify({ level: 'warning', title: 'Acción bloqueada a Andrés Mora', body: 'Recepcionista intentó «Anular facturas directamente» sin autorización. IP 192.168.10.21.', link: '/auditoria', ts: iso(at(d, h, m)) });
    })); }
  // P14 · Facturas de proveedores (historial + anomalías)
  const supplierItems = { 1: ['REP-101', 'REP-102', 'REP-107', 'REP-108', 'REP-110', 'REP-113'], 2: ['INS-201', 'INS-202', 'INS-203', 'INS-204', 'INS-205'], 3: ['REP-104', 'REP-105', 'REP-116', 'REP-102'] };
  const purchaseHistory = [];
  for (const sid of [1, 2, 3]) for (let k = 0; k < 6; k++) purchaseHistory.push({ sid, d: 55 - k * 9 - sid, k });
  for (const ph of purchaseHistory) {
    const d = workday(ph.d); const t = at(d, 9, 30 + ph.sid);
    plant(d, t, () => {
      const items = pickN(supplierItems[ph.sid], 2).map((sku) => ({ product_id: prod[sku].id, qty: sku.startsWith('INS') ? ri(40, 90) : ri(50, 110), unit_cost: prod[sku].cost }));
      const key = `proveedor${ph.sid}`; const staffKey = 'contador';
      const row = createSupplierInvoice({ number: `FV-${10000 + ph.sid * 1000 + ph.k * 17 + ri(1, 9)}`, issue_date: dayStr(d), items, description: 'Reposición mensual de inventario' }, U[key], { supplier_id: ph.sid, source: 'portal', ip: U[key].ip, device: U[key].device, now: t, skipDetect: true });
      if (d > 4) { // aprobada → entrada de inventario → pagada
        const t2 = new Date(t.getTime() + 26 * 3600e3);
        run("UPDATE supplier_invoices SET status='aprobada', resolved_by=?, stock_applied=1, delivery_confirmed=1, delivered_at=? WHERE id=?", U[staffKey].id, iso(t2), row.id);
        for (const it of items) { run('UPDATE products SET stock = stock + ?, cost = ? WHERE id=?', it.qty, it.unit_cost, it.product_id); run("INSERT INTO stock_movements (product_id,qty,reason,ref_type,ref_id,note,user_id,created_at) VALUES (?,?,'compra','supplier_invoice',?,?,?,?)", it.product_id, it.qty, row.id, `Factura ${row.number}`, U[staffKey].id, iso(t2)); }
        logAs(staffKey, 'MODIFICACION', 'factura_proveedor', row.id, `${row.number}: aprobar (₡${row.amount.toLocaleString('es-CR')})`, t2);
        if (d > 18) { const t3 = new Date(t2.getTime() + 6 * 86400e3); run("UPDATE supplier_invoices SET status='pagada' WHERE id=?", row.id); logAs(staffKey, 'MODIFICACION', 'factura_proveedor', row.id, `${row.number}: pagar (₡${row.amount.toLocaleString('es-CR')})`, t3); }
      }
    });
  }
  // Facturas actuales de proveedores: duplicado con otro consecutivo, monto atípico y un intento duplicado bloqueado
  { const d = workday(6); plant(d, at(d, 9, 5), () => createSupplierInvoice({ number: 'FV-20391', issue_date: dayStr(d), amount: 486500, description: 'Pedido de frenos y filtros' }, U.proveedor1, { supplier_id: 1, source: 'portal', ip: U.proveedor1.ip, device: U.proveedor1.device, now: at(d, 9, 5), skipDetect: true }));
    const d2 = workday(2); plant(d2, at(d2, 8, 50), () => createSupplierInvoice({ number: 'FV-20417', issue_date: dayStr(d2), amount: 486500, description: 'Pedido de frenos y filtros (reenvío)' }, U.proveedor1, { supplier_id: 1, source: 'portal', ip: U.proveedor1.ip, device: U.proveedor1.device, now: at(d2, 8, 50), skipDetect: true }));
    plant(d2, at(d2, 9, 2), () => { try { createSupplierInvoice({ number: 'FV-20417', issue_date: dayStr(d2), amount: 486500 }, U.proveedor1, { supplier_id: 1, source: 'portal', ip: U.proveedor1.ip, device: U.proveedor1.device, now: at(d2, 9, 2), skipDetect: true }); } catch (e) { if (!(e instanceof HttpError)) throw e; } });
    plant(d2, at(d2, 15, 20), () => createSupplierInvoice({ number: 'LA-5530', issue_date: dayStr(d2), items: [{ product_id: prod['INS-201'].id, qty: 500, unit_cost: 9700 }], description: 'Compra especial de aceite sintético' }, U.proveedor2, { supplier_id: 2, source: 'portal', ip: U.proveedor2.ip, device: U.proveedor2.device, now: at(d2, 15, 20), skipDetect: true }));
    const d3 = workday(1); plant(d3, at(d3, 10, 15), () => { const row = createSupplierInvoice({ number: 'MC-7714', issue_date: dayStr(d3), items: [{ product_id: prod['REP-104'].id, qty: 6, unit_cost: 44000 }, { product_id: prod['REP-105'].id, qty: 6, unit_cost: 38000 }], description: 'Llantas 17" (lote)' }, U.proveedor3, { supplier_id: 3, source: 'portal', ip: U.proveedor3.ip, device: U.proveedor3.device, now: at(d3, 10, 15), skipDetect: true });
      run('UPDATE supplier_invoices SET delivery_confirmed=1, delivered_at=? WHERE id=?', iso(at(d3, 13, 0)), row.id); logEvent({ user: U.proveedor3, action: 'MODIFICACION', entity: 'factura_proveedor', entityId: row.id, detail: `Entrega confirmada para ${row.number}`, ip: U.proveedor3.ip, device: U.proveedor3.device, ts: iso(at(d3, 13, 0)) }); }); }
  // P13 · Anulación aprobada en el pasado + solicitudes pendientes
  { const d = workday(15); plant(d, at(d, 13, 0), () => {
      const inv = invoice({ kind: 'venta', customer_id: customers[2].id, items: lines([{ product: prod['REP-112'], qty: 1 }]) }, 'recepcionista', at(d, 12, 40));
      const t1 = at(d, 13, 0); const t2 = at(d, 15, 30);
      const rq = run("INSERT INTO approval_requests (type,invoice_id,requested_by,reason,status,created_at) VALUES ('anulacion',?,?,?,'pendiente',?)", inv.id, U.contador.id, 'Cliente devolvió el producto: error de modelo', iso(t1));
      logAs('contador', 'CREACION', 'solicitud', Number(rq.lastInsertRowid), `Solicitud de anulación para ${inv.number}: cliente devolvió el producto`, t1);
      voidInvoice(inv.id, U.gerente, { reason: 'Cliente devolvió el producto: error de modelo', ip: U.gerente.ip, device: U.gerente.device, approvedBy: U.gerente, now: t2 });
      run("UPDATE approval_requests SET status='aprobada', resolved_by=?, resolved_at=?, resolution_note='Verificado con el cliente' WHERE id=?", U.gerente.id, iso(t2), Number(rq.lastInsertRowid));
      logAs('gerente', 'APROBACION', 'solicitud', Number(rq.lastInsertRowid), `Aprobó anulación de factura #${inv.id}`, t2);
    }); }

  // ---------- Línea de tiempo diaria ----------
  const logins = [['recepcionista', 8, 10], ['recepcionista2', 8, 25], ['contador', 8, 40], ['gerente', 9, 5]];
  for (let d = 60; d >= 0; d--) {
    const evs = [];
    if (dowOf(d) !== 0) {
      for (const [key, h, m] of logins) { const t = at(d, h - 1, m + ri(0, 15)); if (t < NOW && (key !== 'gerente' || rng() < 0.7)) evs.push({ t, fn: () => logAs(key, 'LOGIN', 'sesion', null, 'Inicio de sesión', t) }); }
      if (rng() < 0.25) { const t = at(d, 9, ri(0, 40)); if (t < NOW) evs.push({ t, fn: () => logAs('admin', 'LOGIN', 'sesion', null, 'Inicio de sesión', t) }); }
      const n = ri(2, 5);
      for (let k = 0; k < n; k++) {
        const t = at(d, ri(9, 17), ri(0, 59), ri(0, 59));
        if (t >= NOW) continue;
        evs.push({ t, fn: () => {
          const byKey = pick(['recepcionista', 'recepcionista', 'recepcionista', 'recepcionista2', 'recepcionista2', 'contador']);
          const paid = d > 12 ? rng() < 0.9 : d > 4 ? rng() < 0.6 : rng() < 0.4;
          let forceNumber = null; if (d === gapDay) { forceNumber = fmtNumber(nextNum() + 1); gapDay = -1; }
          if (rng() < 0.62) { // servicio con orden de trabajo
            const cust = pick(customers); const ss = pickN(services, rng() < 0.25 ? 2 : 1);
            const ps = pickN(goods, ri(0, 3)).map((p) => ({ product: p, qty: p.type === 'insumo' ? ri(1, 2) : 1 }));
            const labor = ss.reduce((s, x) => s + x.price, 0);
            const completed = new Date(t.getTime() - ri(8, 40) * 60e3);
            const created = new Date(Math.max(at(d, 7, 50).getTime(), completed.getTime() - ri(25, 150) * 60e3));
            const wo = createWO(cust, { moto: pick(motos), desc: ss.map((s) => s.name.replace(' (mano de obra)', '')).join(' + '), labor, parts: ps }, created, byKey);
            completeWO(wo, completed, byKey);
            invoice({ kind: 'servicio', work_order_id: wo.id, items: lines([...svcLines(ss), ...ps]), paid }, byKey, t, { forceNumber });
          } else { // venta de mostrador
            const cust = rng() < 0.45 ? pick(customers) : null;
            let items;
            for (let tries = 0; tries < 8; tries++) { items = pickN(goods, ri(1, 3)).map((p) => ({ product: p, qty: p.type === 'insumo' ? ri(1, 3) : ri(1, 2) })); if (!seenSig.has(sigOf(d, cust, items))) break; items[0].qty += tries + 3; }
            seenSig.add(sigOf(d, cust, items));
            invoice({ kind: 'venta', customer_id: cust?.id, items: lines(items), paid: paid || rng() < 0.5 }, byKey, t, { forceNumber });
          }
        } });
      }
    }
    for (const p of planted.get(d) || []) if (p.t < NOW) evs.push(p);
    evs.sort((a, b) => a.t - b.t).forEach((e) => e.fn());
  }

  // Órdenes en curso hoy/ayer (ingreso diferido) y cotizaciones de ventas
  { const t = at(0, 8, 30) < NOW ? at(0, 8, 30) : at(1, 16, 0);
    const w1 = createWO(customers[26], { moto: 'Honda CB190R', desc: 'Revisión de 10.000 km', labor: 35000, parts: [{ product: prod['INS-201'], qty: 2 }, { product: prod['REP-109'], qty: 1 }] }, t, 'recepcionista');
    run("UPDATE work_orders SET status='en_proceso' WHERE id=?", w1.id); logAs('recepcionista', 'MODIFICACION', 'orden_trabajo', w1.id, `${w1.number}: estado abierta → en_proceso`, new Date(t.getTime() + 20 * 60e3));
    createWO(customers[30], { moto: 'Yamaha XTZ 125', desc: 'Falla de arranque: revisar motor de arranque', labor: 15000, parts: [] }, new Date(t.getTime() + 35 * 60e3), 'recepcionista2'); }
  const quotes = [
    ['cotizacion', 'Marco Villalobos', [['REP-103', 1], ['SRV-007', 1]], 'enviada', 6], ['precuenta', null, [['REP-104', 1], ['SRV-004', 1]], 'borrador', 4],
    ['cotizacion', 'Rebeca Castro', [['REP-114', 2]], 'aceptada', 3], ['precuenta', null, [['INS-201', 3], ['REP-109', 1], ['SRV-001', 1]], 'enviada', 2],
    ['cotizacion', 'Mensajería Rayo Veloz', [['SRV-002', 3], ['REP-107', 3], ['REP-108', 3]], 'borrador', 1], ['cotizacion', 'Hugo Esquivel', [['REP-106', 1]], 'enviada', 1],
  ];
  quotes.forEach(([type, name, its, status, d], k) => {
    const when = at(workday(d), 11 + (k % 4), 10); if (when > NOW) return;
    const items = its.map(([sku, qty]) => ({ product_id: prod[sku].id, description: prod[sku].name, qty, unit_price: prod[sku].price }));
    const sub = items.reduce((s, i) => s + i.qty * i.unit_price, 0); const total = sub + Math.round(sub * config.taxRate);
    const cust = name ? null : customers[k + 4];
    const r = run('INSERT INTO quotes (number,type,customer_id,customer_name,items_json,total,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      `${type === 'cotizacion' ? 'C' : 'P'}-${String(k + 1).padStart(5, '0')}`, type, cust?.id ?? null, name, JSON.stringify(items), total, status, U.ventas.id, iso(when));
    logAs('ventas', 'CREACION', type, Number(r.lastInsertRowid), `${type === 'cotizacion' ? 'C' : 'P'}-${String(k + 1).padStart(5, '0')} · ₡${total.toLocaleString('es-CR')}`, when);
  });

  // Solicitudes pendientes de aprobación (para que Gerente/Admin tengan qué resolver)
  const pend = all("SELECT id,number FROM invoices WHERE status='pendiente' AND kind='servicio' AND discount=0 ORDER BY id DESC LIMIT 6");
  if (pend[1]) { const t = at(workday(1), 9, 40); const r = run("INSERT INTO approval_requests (type,invoice_id,requested_by,reason,pct,status,created_at) VALUES ('descuento',?,?,?,10,'pendiente',?)", pend[1].id, U.contador.id, 'Cliente frecuente con 5 servicios en el año; solicita descuento de fidelidad', iso(t)); logAs('contador', 'CREACION', 'solicitud', Number(r.lastInsertRowid), `Solicitud de descuento 10% para ${pend[1].number}`, t); }
  if (pend[3]) { const t = at(0, 8, 5) < NOW ? at(0, 8, 5) : at(1, 17, 5); const r = run("INSERT INTO approval_requests (type,invoice_id,requested_by,reason,status,created_at) VALUES ('anulacion',?,?,?,'pendiente',?)", pend[3].id, U.contador.id, 'Factura emitida al cliente equivocado; se reemitirá correctamente', iso(t)); logAs('contador', 'CREACION', 'solicitud', Number(r.lastInsertRowid), `Solicitud de anulación para ${pend[3].number}`, t); }

  // Conteo físico: deja algunos productos en stock bajo para las alertas de inventario
  for (const [sku, target] of [['REP-106', 4], ['REP-118', 2], ['INS-203', 14], ['REP-119', 3]]) {
    const p = get('SELECT id,stock FROM products WHERE sku=?', sku); const delta = target - p.stock;
    run('UPDATE products SET stock=? WHERE id=?', target, p.id);
    run("INSERT INTO stock_movements (product_id,qty,reason,note,user_id,created_at) VALUES (?,?,'ajuste','Conteo físico',?,?)", p.id, delta, U.gerente.id, iso(at(1, 17, 30)));
    logAs('gerente', 'MODIFICACION', 'inventario', p.id, `Ajuste manual ${delta} de ${sku} (conteo físico)`, at(1, 17, 30));
  }

  // Cuentas por pagar: maestro, facturas con anomalías plantadas, aprobaciones y bandeja simulada
  await seedAp(U, at);

  // Primera pasada del Auditor Inteligente sobre todo el histórico
  detect();
  run('UPDATE notifications SET read=1');
  run("UPDATE notifications SET read=0 WHERE id IN (SELECT id FROM notifications WHERE audience='security' ORDER BY id DESC LIMIT 6)");
  const stats = { invoices: get('SELECT COUNT(*) n FROM invoices').n, audit: get('SELECT COUNT(*) n FROM audit_log').n, anomalies: get('SELECT COUNT(*) n FROM anomalies').n };
  console.log(`[seed] ${stats.invoices} facturas · ${stats.audit} eventos de auditoría · ${stats.anomalies} alertas del Auditor Inteligente`);
  return stats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seed({ reset: process.argv.includes('--reset') });
}
