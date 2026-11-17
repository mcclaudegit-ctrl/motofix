import { useRef, useState } from 'react';
import { LuScanLine, LuTriangleAlert, LuCheck, LuX, LuRotateCcw, LuBrainCircuit, LuShieldCheck } from 'react-icons/lu';
import { get, post, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Button, Card, Badge, SevBadge, StatusBadge, Modal, Field, Empty, Spinner, useLoad, useToast, ago, crc } from '../ui.jsx';

const RULES = {
  DUPLICADA_CONTENIDO: 'Factura duplicada', DUPLICADA_MONTO: 'Monto repetido', MONTO_ATIPICO: 'Monto atípico', FUERA_HORARIO: 'Fuera de horario', CONSECUTIVO_FALTANTE: 'Consecutivo faltante',
  DESCUENTO_ALTO: 'Descuento alto', RAFAGA: 'Ráfaga de emisión', MONTO_REDONDO: 'Monto redondo', PROV_MONTO_ATIPICO: 'Proveedor: monto atípico', PROV_DUPLICADA: 'Proveedor: duplicada', REPUESTO_NO_FACTURADO: 'Repuesto no facturado',
  REPUESTO_SIN_CONSUMO: 'Repuesto sin consumo', ACCESO_DENEGADO_REPETIDO: 'Accesos denegados', PERMISOS_ALTERADOS: 'Permisos alterados', ANULACIONES_FRECUENTES: 'Anulaciones frecuentes', DUPLICADO_BLOQUEADO: 'Duplicado bloqueado',
  NIIF15_NO_FACTURADA: 'NIIF 15: sin facturar', NIIF15_PREMATURA: 'NIIF 15: ingreso prematuro', NIIF15_DIFERENCIA: 'NIIF 15: diferencia', NIIF15_DESCUENTO_SIN_APROBAR: 'NIIF 15: descuento sin aprobar',
};
const linkOf = (a) => (a.ref_type === 'invoice' && a.ref_id ? `/facturas/${a.ref_id}` : a.ref_type === 'supplier_invoice' ? '/compras' : a.ref_type === 'work_order' ? '/ordenes' : a.ref_type === 'user' || a.ref_type === 'audit' ? '/auditoria' : null);

export default function AiEngine() {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, reload } = useLoad(() => get('/api/ai/anomalies'), [], { poll: 15000 });
  const [filter, setFilter] = useState({ status: 'abierta', sev: '' });
  const [scan, setScan] = useState(null); // { invoices, idx, done, flagged:Set, result }
  const [note, setNote] = useState(null);
  const timer = useRef(null);

  // Simulación visual del escaneo: recorre las facturas y luego resalta en rojo las sospechosas (PRD criterio 3).
  const start = async () => {
    if (!can('ai.scan')) { post('/api/ai/scan').catch(() => {}); return; }
    try {
      const list = (await get('/api/invoices?limit=500')).invoices.slice().reverse();
      setScan({ invoices: list, idx: 0, done: false, flagged: new Set(), result: null });
      const resultP = post('/api/ai/scan');
      const step = Math.max(1, Math.ceil(list.length / 70));
      let i = 0;
      clearInterval(timer.current);
      timer.current = setInterval(async () => {
        i += step;
        if (i < list.length) { setScan((s) => s && { ...s, idx: i }); return; }
        clearInterval(timer.current);
        const result = await resultP;
        setScan((s) => s && { ...s, idx: list.length, done: true, flagged: new Set(result.flagged_invoice_ids), result });
        reload();
        toast(`Escaneo completo: ${result.summary.open} alertas abiertas (${result.new_count} nuevas)`, result.summary.alta ? 'err' : 'ok');
      }, 45);
    } catch (e) { toast(e.message, 'err'); }
  };

  const setStatus = async (a, status, n) => { try { await patch(`/api/ai/anomalies/${a.id}`, { status, note: n }); toast('Alerta actualizada', 'ok'); setNote(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const rows = (data?.anomalies || []).filter((a) => (!filter.status || a.status === filter.status) && (!filter.sev || a.severity === filter.sev));
  const sm = data?.summary;

  return (
    <>
      <div className="page-head"><div><h1>Motor de IA · detección de anomalías</h1><p>Combina estadística robusta, reglas de negocio y análisis de la bitácora para señalar duplicados, montos atípicos, horarios inconsistentes, descuentos y alteraciones de permisos.</p></div>
        <Button variant="primary" icon={LuScanLine} locked={!can('ai.scan')} trackAs={['boton', 'Escanear facturas (IA)']} onClick={start} disabled={scan && !scan.done}>Escanear facturas</Button></div>

      {scan && (
        <Card title={scan.done ? 'Escaneo completado' : 'Escaneando facturas…'} icon={LuBrainCircuit} className="" >
          <div className="scan">
            <div className="progress" aria-label="Progreso"><i style={{ width: `${(scan.idx / scan.invoices.length) * 100}%` }} /></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>{scan.done ? <b>{scan.invoices.length} facturas, {scan.result.stats.supplier_invoices} compras y {scan.result.stats.audit_events} eventos analizados en {scan.result.duration_ms} ms</b> : <>Analizando <span className="mono">{scan.invoices[Math.min(scan.idx, scan.invoices.length - 1)]?.number}</span> · {Math.min(scan.idx, scan.invoices.length)}/{scan.invoices.length}</>}</span>
              {scan.done && <Badge tone={scan.flagged.size ? 'danger' : 'ok'} icon={scan.flagged.size ? LuTriangleAlert : LuShieldCheck}>{scan.flagged.size} facturas sospechosas</Badge>}
            </div>
            <div className="scan-grid">{(scan.done ? [...scan.invoices].sort((a, b) => scan.flagged.has(b.id) - scan.flagged.has(a.id)) : scan.invoices).map((inv, k) => {
              const cls = scan.done ? (scan.flagged.has(inv.id) ? 'bad' : 'done') : k < scan.idx ? 'done' : k < scan.idx + 3 ? 'now' : '';
              return <Link key={inv.id} to={`/facturas/${inv.id}`} className={`tile ${cls}`} style={{ textDecoration: 'none' }} title={`${inv.customer_name || 'Contado'} · ${crc(inv.total)}`}><span>{inv.number}</span>{cls === 'bad' ? <LuTriangleAlert size={12} /> : cls === 'done' ? <LuCheck size={12} /> : null}</Link>;
            })}</div>
          </div>
        </Card>
      )}

      <div className="grid g4" style={{ margin: '16px 0' }}>
        {[['alta', 'Altas', 'danger'], ['media', 'Medias', 'warn'], ['baja', 'Bajas', 'brand']].map(([k, l, t]) => (
          <div key={k} className="card kpi" style={{ cursor: 'pointer', outline: filter.sev === k ? '2px solid var(--brand)' : 'none' }} onClick={() => setFilter({ ...filter, sev: filter.sev === k ? '' : k })}><div className="label">Severidad {l}</div><div className="value">{sm?.[k] ?? '—'}</div><div className="sub">alertas abiertas</div></div>))}
        <div className="card kpi"><div className="label">Total histórico</div><div className="value">{sm?.total ?? '—'}</div><div className="sub">incluye revisadas y descartadas</div></div>
      </div>

      <div className="toolbar"><select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} aria-label="Estado"><option value="">Todos los estados</option><option value="abierta">Abiertas</option><option value="revisada">Revisadas</option><option value="descartada">Descartadas</option></select><span className="muted">{rows.length} alerta(s)</span></div>
      <Card flush>{loading && !data ? <Spinner /> : rows.length === 0 ? <Empty>Sin alertas con esos filtros.</Empty> : rows.map((a) => (
        <div key={a.id} className={`alert-item sev-${a.severity}`} style={a.status !== 'abierta' ? { opacity: 0.6 } : undefined}>
          <div className="ico"><LuTriangleAlert size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h4>{a.title} {a.status !== 'abierta' && <StatusBadge status={a.status} />}</h4><p>{a.detail}</p>
            <small className="muted"><Badge>{RULES[a.rule] || a.rule}</Badge> {ago(a.created_at)} {a.ref_label && linkOf(a) && <>· <Link to={linkOf(a)}>{a.ref_label}</Link></>}{a.review_note && ` · Nota: ${a.review_note}`}</small>
          </div>
          <div style={{ textAlign: 'right', minWidth: 150 }}><SevBadge sev={a.severity} /> <span className="score"><i style={{ width: `${a.score}%` }} /></span> <small className="mono">{a.score}</small>
            {can('ai.scan') && <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              {a.status === 'abierta' ? <><Button size="sm" icon={LuCheck} onClick={() => setStatus(a, 'revisada')}>Revisada</Button><Button size="sm" variant="ghost" icon={LuX} onClick={() => setNote({ a, text: '' })}>Descartar</Button></> : <Button size="sm" icon={LuRotateCcw} onClick={() => setStatus(a, 'abierta')}>Reabrir</Button>}</div>}</div>
        </div>))}</Card>
      {note && <Modal title="Descartar alerta" onClose={() => setNote(null)} footer={<><Button onClick={() => setNote(null)}>Cancelar</Button><Button variant="dark" disabled={note.text.length < 5} onClick={() => setStatus(note.a, 'descartada', note.text)}>Descartar</Button></>}>
        <p className="muted">{note.a.title}</p><Field label="Justificación (queda en la bitácora)"><textarea rows={3} value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} /></Field></Modal>}
    </>
  );
}
