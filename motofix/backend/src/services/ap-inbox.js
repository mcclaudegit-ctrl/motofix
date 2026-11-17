// Bandeja de correo SIMULADA de cuentas por pagar. Ficticia: no envía ni recibe correos reales.
// Cada botón genera facturas aleatorias según el nivel de cumplimiento elegido:
//   cumple     → XML completo de proveedor registrado: se procesa sola, sin respuesta al proveedor.
//   parcial    → PDF sin XML y con formatos sucios: entra con revisión humana y se pide el XML.
//   no_cumple  → sin adjuntos, proveedor no registrado o datos mínimos faltantes: se pide información.
import { all, get, run } from '../db.js';
import { HttpError } from '../lib/http.js';
import { notify } from '../auth.js';
import { logEvent } from '../audit.js';
import { ingest, getSettings } from './ap.js';
import { extractFromPdf } from './ai-extractor.js';
import { crc } from '../lib/time.js';

export const SCENARIOS = {
  cumple: 'Cumple con todo',
  parcial: 'Cumple parcialmente',
  no_cumple: 'No cumple del todo',
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const int = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);
const ddmmyyyy = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const SUBJECT_TAGS = ['Factura', 'Adjunto factura', 'Cobro pendiente', 'Envío de factura electrónica'];

function randomAmount(vendor) {
  // A veces genera montos altos para activar el segundo nivel de aprobación
  const big = Math.random() < 0.2;
  const base = big ? int(760000, 1600000) : int(40000, 420000);
  return Math.round(base / 10) * 10;
}

function buildScenario(level) {
  const vendors = all("SELECT * FROM ap_vendors WHERE status='activo' AND bank_account IS NOT NULL");
  const v = pick(vendors);
  const number = `FE-${int(100000, 999999)}`;
  const issue = isoDaysAgo(int(0, 5));
  const subtotal = randomAmount(v);
  const tax = Math.round(subtotal * 0.13);
  const total = subtotal + tax;
  const cat = v.category || 'Compras de inventario';

  if (level === 'cumple') {
    return {
      counterpart: `facturas@${v.name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}.example`,
      subject: `${pick(SUBJECT_TAGS)} ${number}`,
      body: 'Buenos días. Adjuntamos la factura electrónica en XML. Saludos.',
      attachments: [{ name: `${number}.xml`, type: 'xml' }],
      raw: { vendor_name: v.name, tax_id: v.tax_id, invoice_number: number, issue_date: issue, currency: 'CRC', subtotal, tax, total, category: cat, bank_account: v.bank_account },
      source: 'xml', rawText: null, reply: null,
    };
  }

  if (level === 'parcial') {
    // Mismo proveedor, pero el PDF trae formatos sucios: fechas DD/MM, montos con símbolos, cédula con guiones
    const messy = {
      vendor_name: v.name.toUpperCase(), tax_id: v.tax_id.replace(/^(\d)(\d{3})(\d+)$/, '$1-$2-$3'),
      invoice_number: number.replace('FE-', 'FE- '), issue_date: ddmmyyyy(issue),
      currency: pick(['colones', 'CRC', '₡']), subtotal: `₡ ${subtotal.toLocaleString('es-CR')}`.replace(/,/g, '.'),
      tax: `₡${tax.toLocaleString('es-CR')}`.replace(/,/g, '.'), total: `₡ ${total.toLocaleString('es-CR')},00`.replace(/,/g, '.').replace(/\.(\d{2})$/, ',$1'),
      category: pick(['servicios', 'repuestos', 'Gastos operativos']), bank_account: v.bank_account,
    };
    return {
      counterpart: `cobros@${v.name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}.example`,
      subject: `${pick(SUBJECT_TAGS)} ${number} (PDF)`,
      body: 'Le envío la factura en PDF. Favor confirmar recibido.',
      attachments: [{ name: `${number}.pdf`, type: 'pdf' }],
      raw: null, fallback: messy, source: 'pdf', rawText: `PDF simulado de ${v.name}`, reply: 'Solicitamos al proveedor reenviar la factura en XML (respuesta simulada, no se envió correo real).',
    };
  }

  // no_cumple: variante aleatoria
  if (Math.random() < 0.5) {
    return {
      counterpart: 'ventas@talleres-elchino.example',
      subject: 'Cobro de servicio',
      body: 'Buenas, le debo por el trabajo de la semana pasada, le mando el monto por este medio.',
      attachments: [],
      raw: { vendor_name: 'Taller Mecánico El Chino', tax_id: '3102998877', invoice_number: '', issue_date: '', currency: '', total: '', category: '' },
      source: 'correo', rawText: null, reply: 'Solicitamos al proveedor la factura electrónica en XML, cédula y número de factura (respuesta simulada, no se envió correo real).',
    };
  }
  return {
    counterpart: `facturas@${v.name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}.example`,
    subject: 'Factura',
    body: 'Adjunto lo del mes. Gracias.',
    attachments: [],
    raw: { vendor_name: v.name, tax_id: v.tax_id, invoice_number: '', issue_date: isoDaysAgo(int(0, 3)), currency: 'CRC', subtotal: '', tax: '', total: '', category: cat, bank_account: null },
    source: 'correo', rawText: null, reply: 'Solicitamos al proveedor la factura en XML y el monto total (respuesta simulada, no se envió correo real).',
  };
}

export async function simulateInbox(scenario, actor, { ip, device }) {
  if (!SCENARIOS[scenario]) throw new HttpError(422, 'VALIDACION', 'Escenario inválido (cumple, parcial o no_cumple)');
  const msg = buildScenario(scenario);
  let raw = msg.raw; let extractor = null; let extractorWarning = null;
  if (msg.source === 'pdf') {
    const ex = await extractFromPdf({ base64Pdf: Buffer.from(`%PDF simulado ${msg.subject}`).toString('base64'), fallback: msg.fallback });
    raw = ex.fields; extractor = ex.provider; extractorWarning = ex.warning || null;
  }
  const received = new Date().toISOString();
  const inboxRow = run(`INSERT INTO ap_inbox (direction,counterpart,subject,body,attachments,scenario,outcome,extractor,received_at)
    VALUES ('entrada',?,?,?,?,?,'pendiente',?,?)`, msg.counterpart, msg.subject, msg.body, JSON.stringify(msg.attachments), scenario, extractor, received);
  const inboxId = Number(inboxRow.lastInsertRowid);
  const inv = ingest(raw, { source: msg.source, actor, ip, device, now: new Date(received), inboxId, rawText: msg.rawText, needsReview: msg.source === 'pdf' });

  // Regla de correo: siempre se avisa internamente; se responde al proveedor solo si falta XML o datos mínimos.
  const hasCritical = JSON.parse(inv.quality_issues || '[]').some((q) => q.critical);
  const reply = msg.reply || (hasCritical ? 'Solicitamos al proveedor los datos mínimos faltantes (respuesta simulada).' : null);
  const outcome = msg.source === 'xml' ? 'Procesada automáticamente (XML completo). Sin respuesta al proveedor.'
    : msg.source === 'pdf' ? `Extraída del PDF. Requiere revisión humana antes de aprobar. ${reply}`
    : `Incompleta: ${hasCritical ? 'faltan datos mínimos' : 'sin adjunto'}. ${reply}`;
  run('UPDATE ap_inbox SET outcome=?, invoice_id=? WHERE id=?', outcome, inv.id, inboxId);
  notify({ level: 'info', title: `Correo recibido: ${msg.subject}`, body: `${msg.counterpart} · ${inv.vendor_name || 'sin proveedor'} · ${crc(inv.total_crc)} · riesgo ${inv.risk_level}`, link: `/cxp/facturas/${inv.id}`, ts: received });
  logEvent({ user: actor, action: 'CXP_BANDEJA', entity: 'bandeja_cxp', entityId: inboxId, ip, device, ts: received,
    detail: `${SCENARIOS[scenario]} · ${msg.counterpart} · ${inv.invoice_number || 'sin número'}${extractorWarning ? ` · ${extractorWarning}` : ''}` });
  return { inbox: get('SELECT * FROM ap_inbox WHERE id=?', inboxId), invoice: inv, outcome, extractor, warning: extractorWarning, limit: getSettings().limite_aprobacion, scenarios: SCENARIOS };
}
