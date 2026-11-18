// Reportes automáticos de CxP en PDF, Excel (.xlsx) y CSV, sin dependencias externas.
import { all, get, run } from '../db.js';
import { HttpError } from '../lib/http.js';
import { getSettings } from './ap.js';
import { crc } from '../lib/time.js';
import { buildXlsx } from '../lib/xlsx.js';

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', // reportes antiguos (SpreadsheetML 2003)
  csv: 'text/csv; charset=utf-8',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const REPORT_KINDS = {
  riesgo: 'Resumen de riesgo por nivel',
  pendientes: 'Facturas pendientes de aprobación',
  hallazgos: 'Detalle de hallazgos de auditoría',
};

function dataset(kind) {
  const S = getSettings();
  const rows = all(`SELECT id,invoice_number,vendor_name,vendor_tax_id,issue_date,total_crc,category,source,status,risk_level,risk_score,findings,needs_human_review
    FROM ap_invoices ORDER BY CASE risk_level WHEN 'alto' THEN 0 WHEN 'medio' THEN 1 ELSE 2 END, total_crc DESC`);
  const open = rows.filter((r) => r.status === 'en_revision' || r.status === 'aprobada_parcial');
  if (kind === 'pendientes') return { rows: open, S };
  return { rows, open, S };
}

function summaryLines(rows, open, S) {
  const lv = (l) => ({ n: open.filter((r) => r.risk_level === l).length, m: open.filter((r) => r.risk_level === l).reduce((s, r) => s + r.total_crc, 0) });
  const a = lv('alto'); const m = lv('medio'); const b = lv('bajo');
  return [
    `Facturas abiertas: ${open.length} por ${crc(open.reduce((s, r) => s + r.total_crc, 0))}`,
    `Riesgo ALTO: ${a.n} factura(s), ${crc(a.m)}`,
    `Riesgo MEDIO: ${m.n} factura(s), ${crc(m.m)}`,
    `Riesgo BAJO: ${b.n} factura(s), ${crc(b.m)}`,
    `Límite de aprobación de segundo nivel: ${crc(S.limite_aprobacion)} · Tipo de cambio: ${S.tipo_cambio_usd} CRC/USD`,
  ];
}

function tableRows(kind, rows) {
  if (kind === 'hallazgos') {
    const out = [['Factura', 'Proveedor', 'Riesgo', 'Regla', 'Detalle']];
    for (const r of rows) for (const f of JSON.parse(r.findings || '[]')) out.push([r.invoice_number, r.vendor_name, r.risk_level, f.label, f.detail]);
    return out;
  }
  return [['Factura', 'Proveedor', 'Fecha', 'Total CRC', 'Categoría', 'Estado', 'Riesgo', 'Puntaje'],
    ...rows.map((r) => [r.invoice_number, r.vendor_name, r.issue_date, Math.round(r.total_crc), r.category, r.status, r.risk_level, r.risk_score])];
}

/** Escribe un PDF simple con texto Helvetica (WinAnsi). Sin dependencias externas. */
export function buildPdf(title, lines) {
  const clean = (s) => String(s ?? '').replace(/₡/g, 'CRC ').replace(/[^\x00-\xff]/g, '?').replace(/[\\()]/g, (c) => '\\' + c);
  const PER_PAGE = 48; const pages = [];
  for (let i = 0; i < lines.length; i += PER_PAGE) pages.push(lines.slice(i, i + PER_PAGE));
  if (!pages.length) pages.push([]);
  const objs = []; // cada entrada es un Buffer con el cuerpo del objeto
  const N = pages.length;
  const pageObjs = pages.map((_, i) => 5 + 2 * i);
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pageObjs.map((o) => `${o} 0 R`).join(' ')}] /Count ${N} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((lines, i) => {
    let content = `BT /F2 13 Tf 40 760 Td (${clean(title)}) Tj ET\n`;
    content += `BT /F1 8 Tf 40 746 Td (Generado ${clean(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · MotoFix CxP · Pagina ${i + 1} de ${N}) Tj ET\n`;
    let y = 726;
    for (const l of lines) {
      const bold = /^(===|Riesgo|Facturas abiertas)/.test(l);
      content += `BT /${bold ? 'F2' : 'F1'} 9 Tf 40 ${y} Td (${clean(l).slice(0, 150)}) Tj ET\n`;
      y -= 14;
    }
    const cbuf = Buffer.from(content, 'latin1');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObjs[i] + 1} 0 R >>`);
    objs.push({ stream: cbuf });
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = []; let len = parts[0].length;
  objs.forEach((o, idx) => {
    offsets.push(len);
    const body = typeof o === 'string'
      ? Buffer.from(`${idx + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${idx + 1} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(body); len += body.length;
  });
  const xref = len;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}

function buildCsv(table) {
  const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + table.map((r) => r.map(q).join(',')).join('\r\n');
}

/** Genera un reporte, lo guarda y devuelve su metadato. */
export function generateReport({ kind, format, actor = null, scheduled = false }) {
  if (!REPORT_KINDS[kind]) throw new HttpError(422, 'VALIDACION', 'Tipo de reporte inválido');
  if (format === 'xls') format = 'xlsx'; // «Excel» siempre se genera como .xlsx moderno
  if (!['pdf', 'xlsx', 'csv'].includes(format)) throw new HttpError(422, 'VALIDACION', 'Formato inválido (pdf, xlsx o csv)');
  const title = REPORT_KINDS[kind];
  const { rows, open, S } = dataset(kind);
  const base = kind === 'pendientes' ? rows : rows;
  let content; let mime;
  const lines = [];
  if (format === 'pdf') {
    lines.push(...summaryLines(rows, open || rows, S), '');
    if (kind === 'hallazgos') {
      for (const r of base) {
        const fs = JSON.parse(r.findings || '[]');
        if (!fs.length) continue;
        lines.push(`=== ${r.invoice_number} · ${r.vendor_name} · riesgo ${r.risk_level} (${r.risk_score}) ===`);
        for (const f of fs) lines.push(`  - ${f.label}: ${f.detail}`);
      }
    } else {
      for (const r of base) lines.push(`${r.invoice_number} | ${r.vendor_name} | ${r.issue_date} | ${crc(r.total_crc)} | ${r.status} | riesgo ${r.risk_level} (${r.risk_score})`);
    }
    content = buildPdf(title, lines); mime = 'application/pdf';
  } else {
    const table = tableRows(kind, base);
    if (format === 'xlsx') { content = buildXlsx(title, table); mime = MIME.xlsx; }
    else { content = Buffer.from(buildCsv(table), 'utf8'); mime = 'text/csv; charset=utf-8'; }
  }
  const created = new Date().toISOString();
  const r = run('INSERT INTO ap_reports (kind,format,title,content,scheduled,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    kind, format, title, content, scheduled ? 1 : 0, actor?.id ?? null, created);
  return { id: Number(r.lastInsertRowid), kind, format, title, mime, size: content.length, created_at: created, scheduled };
}

export const listReports = () => all('SELECT id,kind,format,title,scheduled,created_at,LENGTH(content) size FROM ap_reports ORDER BY id DESC LIMIT 50');

export function getReport(id) {
  const r = get('SELECT * FROM ap_reports WHERE id=?', id);
  if (!r) throw new HttpError(404, 'NO_ENCONTRADO', 'Reporte no encontrado');
  return { body: r.content, mime: MIME[r.format] || 'application/octet-stream', filename: `motofix-cxp-${r.kind}-${r.id}.${r.format}` };
}

/** Reporte semanal automático: se genera si el último programado tiene más de 7 días. */
export function runScheduledReports() {
  const last = get("SELECT created_at FROM ap_reports WHERE scheduled=1 ORDER BY id DESC LIMIT 1");
  if (last && Date.now() - Date.parse(last.created_at) < 7 * 86400e3) return null;
  return generateReport({ kind: 'riesgo', format: 'pdf', scheduled: true });
}
