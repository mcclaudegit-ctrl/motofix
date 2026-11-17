import { useState } from 'react';
import { LuCheck, LuX } from 'react-icons/lu';
import { get, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Button, Card, StatusBadge, Badge, Modal, Field, Empty, Spinner, useLoad, useToast, crc, fmtDate } from '../ui.jsx';

export default function Approvals() {
  const { can, user } = useAuth(); const toast = useToast();
  const { data, loading, reload } = useLoad(() => get('/api/approvals'), [], { poll: 10000 });
  const [dlg, setDlg] = useState(null);
  const resolve = async () => {
    try { await patch(`/api/approvals/${dlg.a.id}`, { decision: dlg.decision, note: dlg.note || undefined }); toast(`Solicitud ${dlg.decision}`, 'ok'); setDlg(null); reload(); }
    catch (e) { toast(e.message, 'err'); setDlg(null); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Aprobaciones</h1><p>Flujo de solicitud y aprobación de anulaciones y descuentos. Nadie puede resolver su propia solicitud (segregación de funciones).</p></div></div>
      <Card flush>{loading && !data ? <Spinner /> : data.approvals.length === 0 ? <Empty>No hay solicitudes.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Solicitud</th><th>Factura</th><th>Motivo</th><th>Solicitó</th><th>Estado</th><th /></tr></thead>
          <tbody>{data.approvals.map((a) => <tr key={a.id}><td><Badge tone={a.type === 'anulacion' ? 'danger' : 'warn'}>{a.type === 'anulacion' ? 'Anulación' : `Descuento ${a.pct}%`}</Badge><br /><small className="muted">{fmtDate(a.created_at, true)}</small></td>
            <td><Link to={`/facturas/${a.invoice_id}`} className="mono"><b>{a.invoice_number}</b></Link><br /><small className="muted">{a.customer_name || 'Contado'} · {crc(a.invoice_total)}</small></td>
            <td style={{ maxWidth: 320 }}>{a.reason}{a.resolution_note && <><br /><small className="muted">Resolución: {a.resolution_note}</small></>}</td><td>{a.requested_by_name}</td>
            <td><StatusBadge status={a.status} />{a.resolved_by_name && <><br /><small className="muted">{a.resolved_by_name}</small></>}</td>
            <td>{a.status === 'pendiente' && can('approvals.resolve') && (a.requested_by === user.id ? <small className="muted">Tu solicitud</small> :
              <div className="actions" style={{ justifyContent: 'flex-end' }}><Button size="sm" variant="primary" icon={LuCheck} onClick={() => setDlg({ a, decision: 'aprobada', note: '' })}>Aprobar</Button><Button size="sm" variant="danger" icon={LuX} onClick={() => setDlg({ a, decision: 'rechazada', note: '' })}>Rechazar</Button></div>)}</td></tr>)}</tbody></table></div>)}</Card>
      {dlg && <Modal title={`${dlg.decision === 'aprobada' ? 'Aprobar' : 'Rechazar'} ${dlg.a.type === 'anulacion' ? 'anulación' : 'descuento'} de ${dlg.a.invoice_number}`} onClose={() => setDlg(null)}
        footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant={dlg.decision === 'aprobada' ? 'primary' : 'danger'} disabled={dlg.decision === 'rechazada' && !dlg.note} onClick={resolve}>Confirmar</Button></>}>
        <p className="muted">«{dlg.a.reason}»</p><Field label={dlg.decision === 'aprobada' ? 'Nota (opcional)' : 'Motivo del rechazo *'}><textarea rows={3} value={dlg.note} onChange={(e) => setDlg({ ...dlg, note: e.target.value })} /></Field></Modal>}
    </>
  );
}
