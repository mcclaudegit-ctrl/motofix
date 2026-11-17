import { all } from './db.js';
import { crc, daysBetween } from './lib/time.js';

/**
 * Monitor de reglas contables NIIF 15 (PRD 1.5.3): cruce Orden de Trabajo vs. Factura.
 * Modelo de 5 pasos aplicado al taller:
 *   contrato = orden de trabajo · obligación de desempeño = servicio/repuestos entregados
 *   precio de transacción = mano de obra + repuestos (menos descuentos) · reconocimiento = al completar la orden.
 * Es una herramienta de apoyo al control interno; no reemplaza el juicio profesional del contador.
 */
export function niif15Report(now = new Date()) {
  const wos = all(`SELECT w.*, c.name customer_name FROM work_orders w JOIN customers c ON c.id=w.customer_id WHERE w.status != 'cancelada' ORDER BY w.id DESC`);
  const rows = [];
  const findings = [];
  const sum = { reconocido: 0, diferido: 0, por_facturar: 0, ordenes: wos.length, excepciones: 0, conformes: 0 };

  // Carga en bloque: repuestos por orden y primera factura vigente por orden (sin consultas por fila).
  const partsByWo = new Map();
  for (const p of all('SELECT work_order_id wid, qty, unit_price FROM work_order_parts ORDER BY id'))
    (partsByWo.get(p.wid) || partsByWo.set(p.wid, []).get(p.wid)).push(p);
  const invoiceByWo = new Map();
  for (const i of all("SELECT * FROM invoices WHERE work_order_id IS NOT NULL AND status != 'anulada' ORDER BY id"))
    if (!invoiceByWo.has(i.work_order_id)) invoiceByWo.set(i.work_order_id, i);

  for (const w of wos) {
    const parts = partsByWo.get(w.id) || [];
    const expected = w.labor_amount + parts.reduce((s, p) => s + p.qty * p.unit_price, 0);
    const invoice = invoiceByWo.get(w.id);
    const checks = [];
    let state;

    if (!invoice) {
      if (w.status === 'completada') {
        const age = daysBetween(w.completed_at, now);
        state = 'por_facturar';
        sum.por_facturar += expected;
        checks.push({ ok: age < 3, text: `Obligación cumplida hace ${age.toFixed(0)} día(s) sin factura emitida` });
        if (age >= 3) findings.push({
          rule: 'NIIF15_NO_FACTURADA', severity: age >= 7 ? 'alta' : 'media', ref_type: 'work_order', ref_id: w.id, ref_label: w.number,
          title: `Orden ${w.number} completada sin facturar (${age.toFixed(0)} días)`,
          detail: `NIIF 15: la obligación de desempeño se cumplió pero el ingreso (${crc(expected)}) no está reconocido. Cliente: ${w.customer_name}.`, dedupe_key: `niif-nofact:${w.id}` });
      } else {
        state = 'diferido';
        sum.diferido += expected;
        checks.push({ ok: true, text: 'Obligación pendiente: el ingreso se difiere hasta completar la orden' });
      }
    } else {
      const premature = !w.completed_at || new Date(invoice.created_at) < new Date(w.completed_at);
      const diff = invoice.subtotal - expected;
      const tolerance = Math.max(1000, expected * 0.01);
      const mismatch = Math.abs(diff) > tolerance;
      const discountUnapproved = invoice.discount > 0 && !invoice.discount_approved_by;
      state = premature ? 'prematuro' : 'reconocido';
      checks.push({ ok: !premature, text: premature ? 'Facturada antes de completar la obligación de desempeño' : 'Facturada tras completar la obligación' });
      checks.push({ ok: !mismatch, text: mismatch ? `Contraprestación difiere en ${crc(diff)} (esperado ${crc(expected)}, facturado ${crc(invoice.subtotal)})` : 'Monto facturado coincide con el valor de la orden' });
      if (invoice.discount > 0) checks.push({ ok: !discountUnapproved, text: discountUnapproved ? 'Descuento sin aprobación registrada (contraprestación variable)' : 'Descuento con aprobación registrada' });

      if (!premature) sum.reconocido += invoice.subtotal - invoice.discount;
      const base = { ref_type: 'invoice', ref_id: invoice.id, ref_label: invoice.number };
      if (premature) findings.push({ ...base, rule: 'NIIF15_PREMATURA', severity: 'alta', title: `Ingreso reconocido antes de tiempo en ${invoice.number}`,
        detail: `La factura se emitió antes de completar ${w.number}. Reconocer ingresos sin cumplir la obligación contraviene NIIF 15.`, dedupe_key: `niif-prem:${invoice.id}` });
      if (mismatch) findings.push({ ...base, rule: 'NIIF15_DIFERENCIA', severity: Math.abs(diff) > expected * 0.1 ? 'alta' : 'media', title: `Diferencia orden vs. factura en ${invoice.number}`,
        detail: `${w.number} vale ${crc(expected)} (mano de obra + repuestos) pero la factura registra ${crc(invoice.subtotal)} antes de descuentos.`, dedupe_key: `niif-diff:${invoice.id}` });
      if (discountUnapproved) findings.push({ ...base, rule: 'NIIF15_DESCUENTO_SIN_APROBAR', severity: 'alta', title: `Descuento sin aprobación en ${invoice.number}`,
        detail: `Descuento de ${crc(invoice.discount)} sin autorización de Gerente/Admin. La contraprestación variable debe estar respaldada.`, dedupe_key: `niif-disc:${invoice.id}` });
    }

    const compliant = checks.every((c) => c.ok);
    if (state !== 'diferido') compliant ? sum.conformes++ : sum.excepciones++;
    rows.push({
      work_order_id: w.id, number: w.number, customer: w.customer_name, motorcycle: w.motorcycle, wo_status: w.status,
      completed_at: w.completed_at, expected, invoice_id: invoice?.id ?? null, invoice_number: invoice?.number ?? null,
      invoiced: invoice ? invoice.subtotal : null, discount: invoice?.discount ?? 0, state, compliant, checks,
    });
  }
  return { summary: sum, rows, findings };
}
