import { all, get, run } from './db.js';
import { config } from './config.js';
import { notify } from './auth.js';
import { niif15Report } from './niif15.js';
import { localParts, crc, DOW } from './lib/time.js';

// Motor de detección de anomalías (PRD 1.5.1). Combina estadística robusta (mediana/MAD),
// reglas de negocio y análisis de la bitácora. Es determinista, explicable e idempotente:
// cada hallazgo tiene una `dedupe_key`, así que re-escanear nunca duplica alertas.

// Umbral en escala logarítmica: los importes son log-normales, y 2.5σ robustos separan con claridad lo excepcional.
const LOG_Z_THRESHOLD = 2.5;
const SCORE = { alta: 90, media: 60, baja: 30 };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

/** Puntaje z robusto (Iglewicz–Hoaglin). |z| > 3.5 se considera atípico. */
export function robustZ(values, x) {
  const med = median(values);
  const devs = values.map((v) => Math.abs(v - med));
  const mad = median(devs);
  if (mad > 0) return (0.6745 * (x - med)) / mad;
  const md = mean(devs);
  return md > 0 ? (x - med) / (1.2533 * md) : 0;
}

export function upsertAnomaly(a, known) {
  // `known` (Map dedupe_key → id) evita una consulta por hallazgo cuando se escanea en lote.
  const exists = known ? (known.has(a.dedupe_key) ? { id: known.get(a.dedupe_key) } : undefined)
    : get('SELECT id FROM anomalies WHERE dedupe_key = ?', a.dedupe_key);
  if (exists) return { created: false, id: exists.id };
  const r = run(
    `INSERT INTO anomalies (rule,severity,score,ref_type,ref_id,ref_label,title,detail,status,dedupe_key,created_at)
     VALUES (?,?,?,?,?,?,?,?,'abierta',?,?)`,
    a.rule, a.severity, a.score ?? SCORE[a.severity], a.ref_type, a.ref_id ?? null, a.ref_label ?? null,
    a.title, a.detail ?? null, a.dedupe_key, a.ts || new Date().toISOString(),
  );
  if (a.severity === 'alta') notify({ level: 'critical', title: `Alerta IA: ${a.title}`, body: a.detail, link: '/ia', ts: a.ts });
  const id = Number(r.lastInsertRowid);
  known?.set(a.dedupe_key, id);
  return { created: true, id };
}

export function detect() {
  const created = [];
  const known = new Map(all('SELECT dedupe_key, id FROM anomalies').map((r) => [r.dedupe_key, r.id]));
  const push = (a) => { const r = upsertAnomaly(a, known); if (r.created) created.push({ ...a, id: r.id }); };
  const inv = (i, rule, severity, title, detail, key = `${rule}:${i.id}`) =>
    push({ rule, severity, ref_type: 'invoice', ref_id: i.id, ref_label: i.number, title, detail, dedupe_key: key, ts: i.created_at });

  const invoices = all(`
    SELECT i.id,i.number,i.kind,i.total,i.subtotal,i.discount,i.customer_id,i.content_hash,i.created_by,i.created_at,
           i.override_reason,u.name AS user_name,c.name AS customer_name
    FROM invoices i LEFT JOIN users u ON u.id=i.created_by LEFT JOIN customers c ON c.id=i.customer_id
    WHERE i.status != 'anulada' ORDER BY i.created_at, i.id`);

  // R1 — mismo contenido (hash) emitido más de una vez
  const byHash = new Map();
  for (const i of invoices) {
    const first = byHash.get(i.content_hash);
    if (!first) { byHash.set(i.content_hash, i); continue; }
    inv(i, 'DUPLICADA_CONTENIDO', i.override_reason ? 'media' : 'alta',
      `Factura ${i.number} duplica el contenido de ${first.number}`,
      `Mismo cliente, líneas y monto (${crc(i.total)}) el mismo día. Emitida por ${i.user_name}.` +
        (i.override_reason ? ` Autorizada con justificación: «${i.override_reason}».` : ''));
  }

  // R2 — mismo cliente y monto exacto dentro de 72 h (aunque cambie el detalle)
  const byCustomer = new Map();
  for (const i of invoices) if (i.customer_id) (byCustomer.get(i.customer_id) || byCustomer.set(i.customer_id, []).get(i.customer_id)).push(i);
  for (const list of byCustomer.values()) {
    for (let k = 1; k < list.length; k++) {
      const prev = list.slice(0, k).find((p) => p.total === list[k].total && p.content_hash !== list[k].content_hash &&
        new Date(list[k].created_at) - new Date(p.created_at) <= 72 * 3600e3);
      if (prev) inv(list[k], 'DUPLICADA_MONTO', 'media', `Monto repetido para ${list[k].customer_name}: ${crc(list[k].total)}`,
        `${list[k].number} coincide en cliente y monto con ${prev.number} dentro de 72 horas.`);
    }
  }

  // R3 — montos atípicos (z-score robusto por tipo de factura)
  for (const kind of ['venta', 'servicio']) {
    const set = invoices.filter((i) => i.kind === kind);
    if (set.length < 8) continue;
    // Los importes son muy asimétricos: se evalúa en escala logarítmica para no marcar ventas grandes pero habituales.
    const logs = set.map((i) => Math.log(i.total));
    const med = median(set.map((i) => i.total));
    for (const i of set) {
      const z = robustZ(logs, Math.log(i.total));
      if (z > LOG_Z_THRESHOLD) inv(i, 'MONTO_ATIPICO', i.total >= 10 * med ? 'alta' : 'media', `Monto atípico en ${i.number}: ${crc(i.total)}`,
        `Mediana de facturas de ${kind}: ${crc(med)} (esta es ${(i.total / med).toFixed(0)}×). Desviación robusta de ${z.toFixed(1)}σ en escala logarítmica (umbral ${LOG_Z_THRESHOLD}σ).`);
    }
  }

  // R4 — horarios inconsistentes (fuera de jornada o domingo)
  for (const i of invoices) {
    const p = localParts(i.created_at);
    if (p.hour < config.businessHours.start || p.hour >= config.businessHours.end || p.dow === 0) {
      inv(i, 'FUERA_HORARIO', 'media', `Factura ${i.number} emitida fuera de horario`,
        `Emitida el ${DOW[p.dow]} ${p.date} a las ${p.hm} por ${i.user_name}. Jornada habitual: ${config.businessHours.start}:00–${config.businessHours.end}:00, lunes a sábado.`);
    }
  }

  // R5 — consecutivos faltantes (incluye anuladas: una anulación conserva el número)
  const nums = all("SELECT CAST(SUBSTR(number,3) AS INTEGER) n FROM invoices ORDER BY n").map((r) => r.n);
  const have = new Set(nums);
  let gaps = 0;
  for (let n = nums[0]; n < nums[nums.length - 1] && gaps < 50; n++) {
    if (!have.has(n)) {
      gaps++;
      const label = `F-${String(n).padStart(6, '0')}`;
      push({ rule: 'CONSECUTIVO_FALTANTE', severity: 'media', ref_type: 'invoice', ref_id: null, ref_label: label,
        title: `Consecutivo faltante ${label}`, detail: 'Hay un salto en la numeración de facturas de venta. Puede indicar un documento eliminado o no registrado.',
        dedupe_key: `gap:${n}` });
    }
  }

  // R6 — descuentos elevados
  for (const i of invoices) {
    const r = i.subtotal ? i.discount / i.subtotal : 0;
    if (r >= 0.15) inv(i, 'DESCUENTO_ALTO', r >= 0.3 ? 'alta' : 'media', `Descuento de ${(r * 100).toFixed(0)}% en ${i.number}`,
      `Descuento de ${crc(i.discount)} sobre ${crc(i.subtotal)}. Cliente: ${i.customer_name || 'contado'}.`);
  }

  // R7 — ráfagas: ≥5 facturas del mismo usuario en 10 minutos
  const byUser = new Map();
  for (const i of invoices) (byUser.get(i.created_by) || byUser.set(i.created_by, []).get(i.created_by)).push(i);
  for (const list of byUser.values()) {
    for (let a = 0; a < list.length; a++) {
      let b = a;
      while (b + 1 < list.length && new Date(list[b + 1].created_at) - new Date(list[a].created_at) <= 10 * 60e3) b++;
      if (b - a + 1 >= 5) {
        inv(list[b], 'RAFAGA', 'media', `${b - a + 1} facturas en 10 min por ${list[b].user_name}`,
          `Desde ${list[a].number} hasta ${list[b].number}. Patrón de emisión inusualmente rápido.`, `burst:${list[a].id}`);
        a = b;
      }
    }
  }

  // R8 — montos redondos elevados
  for (const i of invoices) {
    if (i.total >= 300000 && i.total % 50000 === 0) inv(i, 'MONTO_REDONDO', 'baja', `Monto redondo en ${i.number}: ${crc(i.total)}`, 'Los montos exactamente redondos y altos suelen requerir revisión documental.');
  }

  // R9 / R10 — facturas de proveedores
  const sup = all(`SELECT s.id,s.number,s.amount,s.issue_date,s.supplier_id,s.created_at,p.name AS supplier_name
                   FROM supplier_invoices s JOIN suppliers p ON p.id=s.supplier_id WHERE s.status != 'rechazada' ORDER BY s.issue_date, s.id`);
  const bySup = new Map();
  for (const s of sup) (bySup.get(s.supplier_id) || bySup.set(s.supplier_id, []).get(s.supplier_id)).push(s);
  for (const list of bySup.values()) {
    const amounts = list.map((s) => s.amount);
    const logAmounts = amounts.map((a) => Math.log(a));
    list.forEach((s, k) => {
      const supA = (rule, sev, title, detail) => push({ rule, severity: sev, ref_type: 'supplier_invoice', ref_id: s.id, ref_label: `${s.supplier_name} · ${s.number}`, title, detail, dedupe_key: `${rule}:${s.id}`, ts: s.created_at });
      if (list.length >= 6) {
        const z = robustZ(logAmounts, Math.log(s.amount));
        const med = median(amounts);
        if (z > LOG_Z_THRESHOLD) supA('PROV_MONTO_ATIPICO', s.amount >= 5 * med ? 'alta' : 'media', `Factura de proveedor atípica: ${s.number}`, `${s.supplier_name} facturó ${crc(s.amount)}; su mediana histórica es ${crc(med)} (${(s.amount / med).toFixed(1)}×, ${z.toFixed(1)}σ log).`);
      }
      const dup = list.slice(0, k).find((p) => p.amount === s.amount && p.number !== s.number && Math.abs(new Date(s.issue_date) - new Date(p.issue_date)) <= 30 * 86400e3);
      if (dup) supA('PROV_DUPLICADA', 'alta', `Posible factura duplicada de ${s.supplier_name}`, `${s.number} repite el monto ${crc(s.amount)} de ${dup.number} con otro consecutivo (≤ 30 días).`);
    });
  }

  // R11 — discrepancia entre repuestos usados (orden de trabajo) y facturados
  const linked = all(`SELECT w.id wid,w.number wnum,i.id iid,i.number inum FROM work_orders w JOIN invoices i ON i.work_order_id=w.id WHERE i.status != 'anulada'`);
  // Se cargan en bloque (3 consultas en total en vez de 2–3 por orden de trabajo).
  const usedByWo = new Map();
  for (const r of all('SELECT wp.work_order_id wid, wp.product_id pid, SUM(wp.qty) q, MAX(wp.unit_price) p, pr.name FROM work_order_parts wp JOIN products pr ON pr.id=wp.product_id GROUP BY wp.work_order_id, wp.product_id ORDER BY wp.work_order_id, wp.product_id'))
    (usedByWo.get(r.wid) || usedByWo.set(r.wid, []).get(r.wid)).push(r);
  const billedByInv = new Map();
  for (const r of all('SELECT invoice_id iid, product_id pid, SUM(qty) q FROM invoice_items WHERE product_id IS NOT NULL GROUP BY invoice_id, product_id ORDER BY invoice_id, product_id'))
    (billedByInv.get(r.iid) || billedByInv.set(r.iid, new Map()).get(r.iid)).set(r.pid, r.q);
  const productById = new Map(all('SELECT id,name,price,type FROM products').map((p) => [p.id, p]));
  for (const l of linked) {
    const used = usedByWo.get(l.wid) || [];
    const billed = billedByInv.get(l.iid) || new Map();
    const seen = new Set();
    for (const u of used) {
      seen.add(u.pid);
      const b = billed.get(u.pid) || 0;
      const i = { id: l.iid, number: l.inum };
      if (b < u.q) inv(i, 'REPUESTO_NO_FACTURADO', (u.q - b) * u.p >= 50000 ? 'alta' : 'media', `Repuesto usado y no facturado en ${l.inum}`, `${l.wnum}: se usaron ${u.q} × ${u.name} pero se facturaron ${b}. Fuga estimada: ${crc((u.q - b) * u.p)}.`, `part-miss:${l.iid}:${u.pid}`);
      if (b > u.q) inv(i, 'REPUESTO_SIN_CONSUMO', (b - u.q) * u.p >= 50000 ? 'alta' : 'media', `Repuesto facturado de más en ${l.inum}`, `${l.wnum}: se usaron ${u.q} × ${u.name} pero se facturaron ${b}. Posible sobrefacturación de ${crc((b - u.q) * u.p)}.`, `part-excess:${l.iid}:${u.pid}`);
    }
    for (const [pid, q] of billed) {
      if (seen.has(pid)) continue;
      const pr = productById.get(pid);
      if (pr && pr.type !== 'servicio') inv({ id: l.iid, number: l.inum }, 'REPUESTO_SIN_CONSUMO', q * pr.price >= 50000 ? 'alta' : 'media', `Repuesto facturado sin uso registrado en ${l.inum}`, `${l.wnum} no registra consumo de ${pr.name}, pero se facturaron ${q}.`, `part-excess:${l.iid}:${pid}`);
    }
  }

  // R12 — intentos repetidos de acciones no permitidas
  const denied = all("SELECT id,user_id,user_name,role,ts FROM audit_log WHERE action='ACCESO_DENEGADO' AND user_id IS NOT NULL ORDER BY id");
  const dByUser = new Map();
  for (const d of denied) (dByUser.get(d.user_id) || dByUser.set(d.user_id, []).get(d.user_id)).push(d);
  for (const list of dByUser.values()) {
    for (let a = 0; a + 2 < list.length; a++) {
      const win = list.filter((d) => { const t = new Date(d.ts) - new Date(list[a].ts); return t >= 0 && t <= 7 * 86400e3; });
      if (win.length >= 3) {
        const u = list[a];
        const week = Math.floor(new Date(u.ts).getTime() / (7 * 86400e3));
        push({ rule: 'ACCESO_DENEGADO_REPETIDO', severity: 'alta', ref_type: 'user', ref_id: u.user_id, ref_label: u.user_name,
          title: `${win.length} intentos bloqueados de ${u.user_name}`, detail: `El rol ${u.role} intentó ${win.length} acciones sin permiso en 7 días. Revisar intención y capacitación.`, dedupe_key: `denied:${u.user_id}:${week}` });
        break;
      }
    }
  }

  // R13 — alteración de permisos
  for (const e of all("SELECT * FROM audit_log WHERE action='MODIFICACION' AND entity='permisos' ORDER BY id")) {
    const p = localParts(e.ts);
    const off = p.hour < config.businessHours.start || p.hour >= config.businessHours.end || p.dow === 0;
    push({ rule: 'PERMISOS_ALTERADOS', severity: off ? 'alta' : 'media', ref_type: 'audit', ref_id: e.id, ref_label: `Bitácora #${e.id}`,
      title: `Permisos modificados por ${e.user_name}${off ? ' fuera de horario' : ''}`, detail: `${e.detail} · ${DOW[p.dow]} ${p.date} ${p.hm} · IP ${e.ip || '—'}`, dedupe_key: `permchange:${e.id}`, ts: e.ts });
  }

  // R14 — solicitudes de anulación frecuentes por el mismo usuario
  for (const r of all("SELECT requested_by uid, u.name, strftime('%Y-%m', a.created_at) m, COUNT(*) n FROM approval_requests a JOIN users u ON u.id=a.requested_by WHERE a.type='anulacion' GROUP BY uid, m HAVING n >= 3")) {
    push({ rule: 'ANULACIONES_FRECUENTES', severity: 'media', ref_type: 'user', ref_id: r.uid, ref_label: r.name, title: `${r.n} solicitudes de anulación de ${r.name} en el mes`, detail: 'Un volumen alto de anulaciones es un indicador clásico de manipulación de ventas.', dedupe_key: `voidreq:${r.uid}:${r.m}` });
  }

  // Cruce NIIF 15 (orden de trabajo vs. factura) alimenta el mismo flujo de alertas
  for (const f of niif15Report().findings) push(f);

  return created;
}

export function listAnomalies({ status } = {}) {
  const rows = all(`SELECT a.*, u.name reviewed_by_name FROM anomalies a LEFT JOIN users u ON u.id=a.reviewed_by
                    ${status ? 'WHERE a.status = ?' : ''} ORDER BY CASE a.status WHEN 'abierta' THEN 0 ELSE 1 END, a.score DESC, a.id DESC`, ...(status ? [status] : []));
  return rows;
}
