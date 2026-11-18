// Facturas de demostración para «Registrar factura»: 10 que cumplen (riesgo bajo), 10 con datos
// erróneos (riesgo medio) y 10 que no cumplen (riesgo alto). Todo es ficticio.
//
// Cada vez que se piden se generan números de factura nuevos y montos con una variación pequeña,
// para que registrar la misma plantilla dos veces no se convierta en un duplicado. Además, cada
// plantilla se evalúa con el mismo motor de riesgo que usará el registro real: si la fecha elegida
// cae cerca de otras facturas y cambia el nivel, se prueba con fechas vecinas hasta obtener el
// nivel esperado. Así el nivel que muestra la pantalla es el que se obtendrá al registrarla.
import { get } from '../db.js';
import { localParts } from '../lib/time.js';
import { cleanRecord } from './ap-clean.js';
import { evaluateInvoice, getSettings, weightMap, levelFor } from './ap.js';

const V = {
  pacifico: ['Repuestos del Pacífico S.A.', '3101884211', 'CR05015202001026284066'],
  lubricantes: ['Lubricantes y Filtros Altura S.A.', '3101771903', 'CR05015202001026284077'],
  frenos: ['Frenos y Llantas Moto Center S.A.', '3101905512', 'CR05015202001026284088'],
  electricos: ['Servicios Eléctricos Tibás S.R.L.', '3102456780', 'CR05015202001026284099'],
  papeleria: ['Papelería y Oficina Central S.A.', '3101332201', 'CR05015202001026284100'],
  telecom: ['Telecomunicaciones Norte S.A.', '3101660045', 'CR05015202001026284111'],
  picado: ['Rolando Picado Mora', '104560789', 'CR05015202001026284122'],
};
const OTRA_CUENTA = 'CR05015202001026289931';

// day: días respecto a hoy (negativo = pasado). sunday: la fecha debe caer en domingo.
// prefix: prefijo del número de factura. raw: campos del formulario (sin número ni fecha).
const reg = (key, total, category, description, extra = {}) => {
  const [vendor_name, tax_id, bank_account] = V[key];
  return { vendor_name, tax_id, bank_account, total, category, description, currency: 'CRC', ...extra };
};

export const DEMO_TEMPLATES = {
  bajo: [
    { title: 'Repuestos: kit de arrastre', why: 'Proveedor registrado, datos completos y monto habitual', day: -30, prefix: 'FE', raw: reg('pacifico', 245000, 'Compras de inventario', 'Kit de arrastre y cadenas 520 (6 unidades)') },
    { title: 'Aceite sintético', why: 'Proveedor registrado, datos completos y monto habitual', day: -9, prefix: 'FE', raw: reg('lubricantes', 78500, 'Compras de inventario', 'Aceite 10W-40 sintético, 24 litros') },
    { title: 'Pastillas y llantas', why: 'Proveedor registrado, datos completos y monto habitual', day: -16, prefix: 'FE', raw: reg('frenos', 112000, 'Compras de inventario', 'Pastillas de freno y llantas 90/90-18') },
    { title: 'Mantenimiento eléctrico', why: 'Proveedor registrado, datos completos y monto habitual', day: -27, prefix: 'FE', raw: reg('electricos', 248000, 'Gastos operativos', 'Mantenimiento eléctrico mensual del taller') },
    { title: 'Papelería y tóner', why: 'Proveedor registrado, datos completos y monto habitual', day: -10, prefix: 'FE', raw: reg('papeleria', 39800, 'Gastos operativos', 'Papelería, tóner y carpetas') },
    { title: 'Internet y telefonía', why: 'Proveedor registrado, datos completos y monto habitual', day: -3, prefix: 'FE', raw: reg('telecom', 46500, 'Gastos operativos', 'Internet de fibra y telefonía del mes') },
    { title: 'Baterías y bujías', why: 'Proveedor registrado, datos completos y monto habitual', day: -40, prefix: 'FE', raw: reg('pacifico', 268000, 'Compras de inventario', 'Baterías 12 V y bujías NGK') },
    { title: 'Filtros de aire y aceite', why: 'Proveedor registrado, datos completos y monto habitual', day: -20, prefix: 'FE', raw: reg('lubricantes', 64000, 'Compras de inventario', 'Filtros de aire y de aceite surtidos') },
    { title: 'Discos de freno (en dólares)', why: 'Proveedor registrado y monto habitual; se convierte de USD a colones', day: -33, prefix: 'FE', raw: reg('frenos', 192, 'Compras de inventario', 'Discos de freno delanteros (2)', { currency: 'USD' }) },
    { title: 'Formularios impresos', why: 'Proveedor registrado, datos completos y monto habitual', day: -22, prefix: 'FE', raw: reg('papeleria', 45200, 'Gastos operativos', 'Formularios de orden de trabajo impresos') },
  ],
  medio: [
    { title: 'Cuenta bancaria cambiada', why: 'La cuenta bancaria no coincide con la del maestro de proveedores', day: -14, prefix: 'FE', raw: reg('pacifico', 230000, 'Compras de inventario', 'Amortiguadores traseros', { bank_account: OTRA_CUENTA }) },
    { title: 'Proveedor no registrado', why: 'La cédula no existe en el maestro de proveedores', day: -6, prefix: 'FE', raw: { vendor_name: 'Taller Hermanos Quesada S.A.', tax_id: '3101998877', bank_account: 'CR05015202001026281234', total: 85000, category: 'Pagos a proveedores', description: 'Rectificación de culata', currency: 'CRC' } },
    { title: 'Nombre no coincide', why: 'La cédula pertenece a otro proveedor del maestro', day: -11, prefix: 'FE', raw: { ...reg('lubricantes', 70000, 'Compras de inventario', 'Grasa y lubricante de cadena'), vendor_name: 'Distribuidora Lubrimax S.A.' } },
    { title: 'Fecha de emisión futura', why: 'La fecha de la factura es posterior a hoy', day: 6, prefix: 'FE', raw: reg('frenos', 105000, 'Compras de inventario', 'Llantas traseras 120/80-17') },
    { title: 'Monto atípico', why: 'El monto es muy superior al historial del proveedor', day: -5, prefix: 'FE', raw: reg('papeleria', 168000, 'Gastos operativos', 'Compra de papelería y archivadores') },
    { title: 'Sin cédula', why: 'Falta la cédula: no se puede validar al proveedor contra el maestro', day: -8, prefix: 'FE', raw: { ...reg('telecom', 47000, 'Gastos operativos', 'Telefonía móvil del personal'), tax_id: '' } },
    { title: 'Cédula mal digitada', why: 'La cédula tiene dígitos de menos y no coincide con el maestro', day: -18, prefix: 'FE', raw: { ...reg('frenos', 99000, 'Compras de inventario', 'Cables de freno y embrague'), tax_id: '3-101-90551' } },
    { title: 'Persona física sin registrar', why: 'El proveedor no está en el maestro de proveedores', day: -4, prefix: 'FE', raw: { vendor_name: 'Carlos Ugalde Rojas', tax_id: '205430987', bank_account: 'CR05015202001026285577', total: 55000, category: 'Pagos a proveedores', description: 'Pintura de tanque y guardabarros', currency: 'CRC' } },
    { title: 'Monto atípico en lubricantes', why: 'El monto es muy superior al historial del proveedor', day: -12, prefix: 'FE', raw: reg('lubricantes', 265000, 'Compras de inventario', 'Aceite y aditivos (pedido grande)') },
    { title: 'Domingo y monto atípico', why: 'Emitida en domingo y con un monto muy superior al habitual', day: -15, sunday: true, prefix: 'FE', raw: reg('telecom', 150000, 'Gastos operativos', 'Instalación de red y telefonía') },
  ],
  alto: [
    { title: 'Proveedor que es empleado', why: 'El proveedor coincide con un empleado del taller (conflicto de interés)', day: -7, prefix: 'FE', raw: reg('picado', 95000, 'Pagos a proveedores', 'Servicio de pintura') },
    { title: 'Empleado sin registrar', why: 'Coincide con un empleado y no está en el maestro de proveedores', day: -3, prefix: 'FE', raw: { vendor_name: 'Andrés Mora Solís', tax_id: '109870234', bank_account: 'CR05015202001026287788', total: 120000, category: 'Pagos a proveedores', description: 'Asesoría técnica', currency: 'CRC' } },
    { title: 'Cuenta cambiada en domingo', why: 'Cuenta bancaria distinta a la del maestro y emitida en domingo', day: -9, sunday: true, prefix: 'FE', raw: reg('pacifico', 252000, 'Compras de inventario', 'Kit de embrague', { bank_account: OTRA_CUENTA }) },
    { title: 'Sin registrar y con fecha futura', why: 'Proveedor fuera del maestro y fecha posterior a hoy', day: 8, prefix: 'FE', raw: { vendor_name: 'Importadora MotoParts Ltda.', tax_id: '3102112233', bank_account: 'CR05015202001026283344', total: 310000, category: 'Compras de inventario', description: 'Repuestos importados', currency: 'CRC' } },
    { title: 'Nombre y cuenta no coinciden', why: 'La cédula es de otro proveedor y la cuenta bancaria fue cambiada', day: -13, prefix: 'FE', raw: { ...reg('electricos', 240000, 'Gastos operativos', 'Revisión de tablero eléctrico', { bank_account: OTRA_CUENTA }), vendor_name: 'Electro Servicios Express' } },
    { title: 'Monto atípico y cuenta cambiada', why: 'Monto muy superior al historial y cuenta bancaria distinta', day: -6, prefix: 'FE', raw: reg('frenos', 420000, 'Compras de inventario', 'Pedido especial de frenos', { bank_account: OTRA_CUENTA }) },
    { title: 'Justo bajo el límite, sin registrar', why: 'Monto a menos de 5% del límite de aprobación, proveedor fuera del maestro y emitida en domingo', day: -20, sunday: true, prefix: 'FE', raw: { vendor_name: 'Comercializadora del Valle S.A.', tax_id: '3101445566', bank_account: 'CR05015202001026286655', total: 690000, category: 'Activos fijos', description: 'Elevador hidráulico para motos', currency: 'CRC' } },
    { title: 'Fecha futura y cuenta cambiada', why: 'Fecha posterior a hoy y cuenta bancaria distinta a la del maestro', day: 5, prefix: 'FE', raw: reg('lubricantes', 82000, 'Compras de inventario', 'Refrigerante y líquido de frenos', { bank_account: OTRA_CUENTA }) },
    { title: 'Factura ya registrada', why: 'Repite el número de una factura que ya existe del mismo proveedor', duplicate: true, prefix: 'FE', raw: reg('electricos', 0, 'Gastos operativos', 'Copia de una factura ya recibida') },
    { title: 'Cédula de una empleada', why: 'La cédula pertenece a una empleada del taller y el proveedor no está registrado', day: -10, prefix: 'FE', raw: { vendor_name: 'Consultores Contables LF', tax_id: '113450678', bank_account: 'CR05015202001026284455', total: 175000, category: 'Gastos operativos', description: 'Servicios de contabilidad', currency: 'CRC' } },
  ],
};

const today = () => localParts(new Date().toISOString()).date;
const shift = (iso, d) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400e3).toISOString().slice(0, 10);
const isSunday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;
const jitter = (n, cur) => {
  const x = n * (1 + (Math.random() * 0.06 - 0.03));
  return cur === 'USD' ? Math.round(x * 100) / 100 : Math.round(x / 50) * 50;
};
const randomNumber = (prefix) => `${prefix}-${String(Math.floor(100000 + Math.random() * 900000))}`;

/** Riesgo que tendría la factura si se registrara ahora por captura manual (sin guardarla). */
export function predictRisk(raw, S = getSettings(), W = weightMap()) {
  const { rec, issues } = cleanRecord(raw);
  const fx = rec.currency === 'USD' ? S.tipo_cambio_usd : 1;
  const total_crc = Math.round((rec.total ?? 0) * fx * 100) / 100;
  const vendor = rec.tax_id ? get('SELECT id FROM ap_vendors WHERE tax_id=?', rec.tax_id) : null;
  const inv = {
    id: -1, quality_issues: JSON.stringify(issues), vendor_name_key: rec.vendor_name_key, vendor_tax_id: rec.tax_id,
    number_key: rec.number_key, source: 'manual', issue_date: rec.issue_date, total_crc, vendor_id: vendor?.id ?? null,
    vendor_name: rec.vendor_name, bank_account: rec.bank_account,
  };
  const findings = evaluateInvoice(inv, S, W);
  const score = Math.min(100, findings.reduce((s, f) => s + f.weight, 0));
  return { score, level: levelFor(score, S), findings: findings.map((f) => f.label) };
}

function candidateDates(t) {
  const base = shift(today(), t.day);
  const out = [];
  for (let k = 0; k < 120 && out.length < 45; k++) {
    const d = shift(base, k % 2 ? -Math.ceil(k / 2) : Math.ceil(k / 2));
    if (t.day > 0 ? d <= today() : d > today()) continue; // futuras siguen siendo futuras; pasadas, pasadas
    if (Boolean(t.sunday) !== isSunday(d)) continue;
    out.push(d);
  }
  return out;
}

function buildOne(t, expected, S, W) {
  if (t.duplicate) {
    // Toma una factura real del mismo proveedor y repite su número por otro canal.
    const src = get(`SELECT invoice_number, issue_date, total, currency FROM ap_invoices WHERE vendor_tax_id=? AND status != 'rechazada' AND invoice_number != '' ORDER BY created_at DESC LIMIT 1`, t.raw.tax_id);
    if (src) {
      const data = { ...t.raw, invoice_number: src.invoice_number, issue_date: src.issue_date, total: src.total, currency: src.currency };
      return { data, prediction: predictRisk(data, S, W) };
    }
  }
  let first = null;
  for (const issue_date of candidateDates(t)) {
    const data = { ...t.raw, total: jitter(t.raw.total || 100000, t.raw.currency), invoice_number: randomNumber(t.prefix), issue_date };
    const prediction = predictRisk(data, S, W);
    first ??= { data, prediction };
    if (prediction.level === expected) return { data, prediction };
  }
  return first;
}

/** Catálogo de las 30 plantillas (sin consultar la base): título, motivo y nivel esperado. */
export function demoCatalog() {
  const out = {};
  for (const [expected, list] of Object.entries(DEMO_TEMPLATES)) out[expected] = list.map((t, i) => ({ id: `${expected}-${i + 1}`, title: t.title, why: t.why, expected }));
  return { templates: out };
}

/** Una plantilla lista para el formulario, con el riesgo que obtendrá si se registra ahora. */
export function demoTemplate(id) {
  const [expected, n] = String(id).split('-');
  const t = DEMO_TEMPLATES[expected]?.[Number(n) - 1];
  if (!t) return null;
  const { data, prediction } = buildOne(t, expected, getSettings(), weightMap());
  return { id, title: t.title, why: t.why, expected, data, prediction };
}
