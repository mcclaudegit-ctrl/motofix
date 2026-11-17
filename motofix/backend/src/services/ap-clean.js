// Módulo 1 · Entrada y limpieza de datos de cuentas por pagar.
// Estandariza nombres, cédulas, fechas, montos, monedas, cuentas y categorías. Cada cambio queda
// registrado en `log` (antes → después) para que el auditor vea exactamente qué se corrigió.

export const CATEGORIES = ['Gastos operativos', 'Compras de inventario', 'Pagos a proveedores', 'Activos fijos'];
const CATEGORY_SYNONYMS = [
  [['gastos operativos', 'operativo', 'operativos', 'servicios', 'gasto', 'gastos'], 'Gastos operativos'],
  [['compras de inventario', 'inventario', 'repuestos', 'insumos', 'mercaderia', 'compras'], 'Compras de inventario'],
  [['pagos a proveedores', 'proveedores', 'pago proveedor', 'pagos'], 'Pagos a proveedores'],
  [['activos fijos', 'activo fijo', 'activos', 'equipo', 'activo'], 'Activos fijos'],
];

export const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Clave de comparación de nombres: sin acentos, sin signos ni razón social (S.A., S.R.L., Ltda.). */
export function nameKey(s) {
  return stripAccents(s).toUpperCase()
    .replace(/\bS\.?\s?A\.?(?=\s|$)/g, ' ').replace(/\bS\.?\s?R\.?\s?L\.?(?=\s|$)/g, ' ').replace(/\bLTDA\.?(?=\s|$)/g, ' ').replace(/\bCIA\.?(?=\s|$)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Nombre para mostrar: espacios, mayúsculas/minúsculas y razón social en formato estándar. */
export function cleanName(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t && (t === t.toUpperCase() || t === t.toLowerCase())) {
    t = t.toLowerCase().replace(/(^|\s|-|\/)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return t.replace(/\bS\.?\s?A\.?(?=\s|$)/gi, 'S.A.').replace(/\bS\.?\s?R\.?\s?L\.?(?=\s|$)/gi, 'S.R.L.');
}

/** Cédula (física, jurídica, DIMEX o NITE): solo dígitos. */
export const cleanTaxId = (s) => { const d = String(s ?? '').replace(/\D/g, ''); return d || null; };

/** Clave del número de factura: sin separadores y sin ceros a la izquierda (FE-000123 ≡ FE-123). */
export function numberKey(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|\D)0+(?=\d)/g, '$1');
}

/** Monto: acepta ₡1.250.000,00 · $1,250.50 · 1250 · (1250) y devuelve número. */
export function parseAmount(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  let s = stripAccents(String(x ?? '')).replace(/₡|\$|\s|CRC|USD|colones|dolares/gi, '');
  if (!s) return null;
  const neg = s.startsWith('-') || /^\(.*\)$/.test(s);
  s = s.replace(/[()\-]/g, '');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  let num;
  let dec = null;
  if (lc > -1 && ld > -1) dec = lc > ld ? ',' : '.';
  else if (lc > -1) dec = s.length - lc - 1 <= 2 && s.split(',').length === 2 ? ',' : null;
  else if (ld > -1) dec = s.length - ld - 1 <= 2 && s.split('.').length === 2 ? '.' : null;
  if (dec) {
    const idx = s.lastIndexOf(dec);
    num = Number(`${s.slice(0, idx).replace(/[.,]/g, '')}.${s.slice(idx + 1)}`);
  } else {
    num = Number(s.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(num)) return null;
  return neg ? -num : num;
}

/** Fecha: ISO (AAAA-MM-DD) o formato costarricense (DD/MM/AAAA). Devuelve ISO o null si no es válida. */
export function parseDate(x) {
  const s = String(x ?? '').trim();
  let m; let y; let mo; let d;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s))) [, d, mo, y] = m;
  else return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).getUTCDate() !== Number(d) || Number(mo) < 1 || Number(mo) > 12) return null;
  return iso;
}

export function cleanCurrency(x) {
  const s = stripAccents(x).toLowerCase();
  if (!s) return null;
  if (/usd|\$|dolar/.test(s)) return 'USD';
  if (/crc|₡|colon|^cr/.test(s)) return 'CRC';
  return null;
}

export function cleanCategory(x) {
  const k = stripAccents(x).toLowerCase().trim();
  if (!k) return { value: 'Gastos operativos', ok: false };
  for (const [words, value] of CATEGORY_SYNONYMS) if (words.includes(k)) return { value, ok: true };
  return { value: 'Gastos operativos', ok: false };
}

export const cleanBank = (s) => (s ? String(s).replace(/\s+/g, '').toUpperCase() || null : null);

/**
 * Limpia un registro crudo (correo, XML, PDF, importación o captura manual).
 * Devuelve el registro estandarizado, la bitácora de cambios y los problemas de calidad.
 * Un problema `critical` impide aprobar la factura hasta que se corrija.
 */
export function cleanRecord(raw = {}) {
  const log = []; const issues = [];
  const note = (field, from, to) => {
    const a = from == null ? '' : String(from); const b = to == null ? '' : String(to);
    if (a !== b) log.push({ field, from: a, to: b });
  };
  const issue = (field, msg, critical = false) => issues.push({ field, msg, critical });

  const vn = raw.vendor_name == null ? '' : String(raw.vendor_name);
  const vendor_name = cleanName(vn); note('Proveedor', vn, vendor_name);
  if (!vendor_name) issue('Proveedor', 'nombre de proveedor ausente', true);

  const tax_raw = raw.tax_id ?? raw.vendor_tax_id;
  const tax_id = cleanTaxId(tax_raw); note('Cédula', tax_raw, tax_id);
  if (!tax_id) issue('Cédula', 'cédula ausente', false);
  else if (tax_id.length < 9 || tax_id.length > 12) issue('Cédula', `longitud inválida (${tax_id.length} dígitos)`, false);

  const num_raw = raw.invoice_number == null ? '' : String(raw.invoice_number);
  const invoice_number = num_raw.replace(/\s+/g, ' ').trim(); note('Número de factura', num_raw, invoice_number);
  if (!invoice_number) issue('Número de factura', 'número ausente', true);

  const date_raw = raw.issue_date; const issue_date = parseDate(date_raw);
  note('Fecha', date_raw, issue_date);
  if (!issue_date) issue('Fecha', 'fecha ausente o inválida', true);

  const cur_raw = raw.currency; const currency = cleanCurrency(cur_raw) || 'CRC';
  note('Moneda', cur_raw ?? '', currency);

  let total = parseAmount(raw.total); note('Total', raw.total, total);
  let subtotal = parseAmount(raw.subtotal); let tax = parseAmount(raw.tax);
  if (total == null || total <= 0) issue('Total', 'monto ausente o inválido', true);
  if (total != null && subtotal == null && tax == null && total > 0) {
    subtotal = Math.round(total / 1.13); tax = total - subtotal;
    log.push({ field: 'Subtotal / IVA', from: '', to: `calculado desde el total (IVA 13%)` });
  } else if (total != null && subtotal != null && tax == null) {
    tax = Math.round(subtotal * 0.13); log.push({ field: 'IVA', from: '', to: `calculado al 13% (${tax})` });
  } else if (total != null && subtotal != null && tax != null && Math.abs(subtotal + tax - total) > 1) {
    issue('Totales', `subtotal + IVA (${subtotal + tax}) no coincide con el total (${total})`, false);
  }

  const cat = cleanCategory(raw.category); note('Categoría', raw.category ?? '', cat.value);
  if (!cat.ok) issue('Categoría', 'sin categoría reconocida; se asignó «Gastos operativos»', false);

  const bank_raw = raw.bank_account; const bank_account = cleanBank(bank_raw); note('Cuenta bancaria', bank_raw, bank_account);

  const description = raw.description ? String(raw.description).replace(/\s+/g, ' ').trim().slice(0, 200) : null;

  return {
    rec: {
      vendor_name, vendor_name_key: nameKey(vendor_name), tax_id, invoice_number, number_key: numberKey(invoice_number),
      issue_date, currency, total, subtotal, tax, category: cat.value, description, bank_account,
    },
    log, issues,
  };
}
