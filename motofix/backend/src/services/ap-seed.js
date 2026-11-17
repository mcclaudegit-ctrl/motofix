// Datos sintéticos de CxP (ficticios). Pasa por los MISMOS servicios de ingreso, limpieza y aprobación
// que usa la API, y planta casos conocidos: duplicados, fraccionamiento, cuenta bancaria cambiada,
// proveedor que es empleado, monto atípico, factura en domingo y proveedor no registrado.
import { run, get } from '../db.js';
import { ingest, approveInvoice, rejectInvoice, ensureApDefaults } from './ap.js';
import { simulateInbox } from './ap-inbox.js';
import { localParts } from '../lib/time.js';

export async function seedAp(U, at) {
  ensureApDefaults();
  const VENDORS = [
    ['Repuestos del Pacífico S.A.', '3101884211', 'Compras de inventario', 'CR05015202001026284066'],
    ['Lubricantes y Filtros Altura S.A.', '3101771903', 'Compras de inventario', 'CR05015202001026284077'],
    ['Frenos y Llantas Moto Center S.A.', '3101905512', 'Compras de inventario', 'CR05015202001026284088'],
    ['Servicios Eléctricos Tibás S.R.L.', '3102456780', 'Gastos operativos', 'CR05015202001026284099'],
    ['Papelería y Oficina Central S.A.', '3101332201', 'Gastos operativos', 'CR05015202001026284100'],
    ['Telecomunicaciones Norte S.A.', '3101660045', 'Gastos operativos', 'CR05015202001026284111'],
    ['Rolando Picado Mora', '104560789', 'Pagos a proveedores', 'CR05015202001026284122'],
  ];
  const vid = {};
  VENDORS.forEach(([name, tax, category, bank], i) => {
    const t = at(120, 9).toISOString();
    const r = run('INSERT INTO ap_vendors (tax_id,name,name_key,category,bank_account,status,created_at) VALUES (?,?,?,?,?,?,?)',
      tax, name, name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(), category, bank, 'activo', t);
    vid[i] = Number(r.lastInsertRowid);
  });

  for (const [name, nid] of [['Lucía Fernández Chacón', '113450678'], ['Andrés Mora Solís', '109870234'], ['Rolando Picado Mora', '104560789'], ['Mariana Solís Vega', '108760543']]) {
    run('INSERT INTO ap_employees (national_id,name,name_key,active) VALUES (?,?,?,1)', nid, name, name.toUpperCase().replace(/\s+/g, ' ').trim());
  }

  // Fecha local de hace d días a las h:m (hora de Costa Rica)
  const day = (d) => localParts(new Date(Date.now() - d * 86400e3).toISOString()).date;
  const sundayAgo = (min) => { let d = min; while (new Date(`${day(d)}T12:00:00Z`).getUTCDay() !== 0) d++; return d; };
  const send = (who, d, h, raw, source = 'xml', extra = {}) =>
    ingest({ ...raw }, { source, actor: U[who], now: at(d, h), ...extra });
  const I = (issue_date, vendorIdx, total, invoice_number, extra = {}) => {
    const [name, tax, category, bank] = VENDORS[vendorIdx];
    return { vendor_name: name, tax_id: tax, invoice_number, issue_date, currency: 'CRC', total, category, bank_account: bank, ...extra };
  };
  const dayIso = (d) => day(d);

  // Historial regular (para que el motor de montos atípicos tenga referencia)
  const regular = [
    [0, [[58, 210000], [48, 255000], [36, 190000], [24, 310000], [12, 285000], [4, 240000]]],
    [1, [[55, 62000], [44, 88000], [30, 54000], [18, 101000], [9, 77000]]],
    [2, [[50, 118000], [40, 96000], [22, 142000], [11, 109000]]],
    [3, [[57, 220000], [45, 265000], [33, 240000], [21, 298000], [8, 251000]]],
    [4, [[52, 34000], [38, 47000], [26, 29000], [14, 51000], [6, 42000]]],
    [5, [[47, 45000], [35, 48000], [23, 46000]]],
  ];
  let k = 0;
  const notSunday = (d) => { let x = d; while (new Date(`${day(x)}T12:00:00Z`).getUTCDay() === 0) x--; return x; };
  for (const [vi, items] of regular) {
    for (const [d0, total] of items) {
      k++;
      const d = notSunday(d0);
      send('contador', d, 10 + (k % 6), I(dayIso(d), vi, total, `FE-${1000 + k}`), 'xml');
    }
  }

  // Casos plantados
  // 1) Monto atípico de Servicios Eléctricos
  send('contador', 2, 11, I(dayIso(2), 3, 4800000, 'FE-ELE-9001'), 'xml');
  // 2) Duplicado por dos canales (mismo número, correo y XML)
  send('contador', 16, 9, I(dayIso(16), 0, 186000, 'FE-REP-2201'), 'correo');
  const dup = send('contador', 16, 15, I(dayIso(16), 0, 186000, 'FE-REP-2201'), 'xml');
  // 3) Mismo número dos veces por el mismo canal (factura repetida)
  send('contador', 9, 9, I(dayIso(9), 4, 33000, 'FE-PAP-0456'), 'xml');
  send('contador', 9, 16, I(dayIso(9), 4, 33000, 'FE-PAP-0456'), 'xml');
  // 4) Monto a 5% del límite (₡690.000)
  send('contador', 7, 13, I(dayIso(7), 4, 690000, 'FE-PAP-0470'), 'xml');
  // 5) Fraccionamiento: tres facturas de Frenos bajo el límite que suman más de ₡700.000 en 2 días
  send('contador', 3, 9, I(dayIso(3), 2, 260000, 'FE-FRN-310'), 'xml');
  send('contador', 3, 11, I(dayIso(3), 2, 280000, 'FE-FRN-311'), 'xml');
  send('contador', 2, 14, I(dayIso(2), 2, 240000, 'FE-FRN-312'), 'xml');
  // 6) Monto mayor al límite (requiere dos aprobaciones)
  const big = send('contador', 5, 10, I(dayIso(5), 0, 850000, 'FE-REP-2188'), 'xml');
  // 7) Misma cantidad y fecha que la anterior de Telecom (duplicado de monto y fecha)
  send('contador', 1, 10, I(dayIso(1), 5, 46000, 'FE-TEL-7782'), 'xml');
  send('contador', 1, 15, I(dayIso(1), 5, 46000, 'FE-TEL-7783'), 'xml');
  // 8) Cuenta bancaria distinta a la del maestro (Telecom)
  send('contador', 0, 9, I(dayIso(0), 5, 52000, 'FE-TEL-7801', { bank_account: 'CR99015100001234567890' }), 'xml');
  // 9) Proveedor que coincide con un empleado
  send('contador', 4, 12, I(dayIso(4), 6, 85000, 'FE-PIC-101'), 'xml');
  // 10) Proveedor no registrado
  send('contador', 6, 10, { vendor_name: 'Taller Mecánico El Chino', tax_id: '3102998877', invoice_number: 'EC-882', issue_date: dayIso(6), currency: 'CRC', total: 120000, category: 'Gastos operativos' }, 'correo');
  // 11) Factura en domingo
  const sun = sundayAgo(3);
  send('contador', sun, 11, I(dayIso(sun), 1, 62000, 'FE-ALT-5520'), 'xml');
  // 12) PDF con datos sucios (queda en revisión humana)
  send('contador', 2, 16, { vendor_name: 'PAPELERIA Y OFICINA CENTRAL S.A.', tax_id: '3-101-332201', invoice_number: 'FE- 0498', issue_date: `${dayIso(2).slice(8)}/${dayIso(2).slice(5, 7)}/${dayIso(2).slice(0, 4)}`, currency: 'colones', total: '₡ 58.500,00', category: 'servicios' }, 'pdf', { needsReview: true, rawText: 'PDF simulado' });

  // Aprobaciones de ejemplo: primer nivel del gerente en facturas antiguas, segundo nivel del admin en la de ₡850.000
  const gerente = U.gerente; const admin = U.admin;
  const approved = [];
  for (let i = 1; i <= 6; i++) {
    const inv = get('SELECT id FROM ap_invoices WHERE invoice_number = ? ', `FE-${1000 + i}`);
    if (inv) approved.push(inv.id);
  }
  for (const id of approved.slice(0, 4)) approveInvoice(id, gerente, { note: 'Factura revisada contra orden de compra', ip: gerente.ip, device: gerente.device });
  approveInvoice(big.id, gerente, { note: 'Compra de inventario según orden aprobada por Dirección', ip: gerente.ip, device: gerente.device });
  approveInvoice(big.id, admin, { note: 'Segunda aprobación: monto sobre el límite de ₡700.000', ip: admin.ip, device: admin.device });
  rejectInvoice(dup.id, gerente, { reason: 'Duplicado de la misma factura recibida por correo', ip: gerente.ip, device: gerente.device });

  // Bandeja de ejemplo (un correo por cada nivel de cumplimiento)
  for (const s of ['cumple', 'parcial', 'no_cumple']) await simulateInbox(s, U.contador, { ip: U.contador.ip, device: U.contador.device });
  return { vendors: VENDORS.length, invoices: get('SELECT COUNT(*) n FROM ap_invoices').n };
}
