import { useState } from 'react';
import { LuPlus, LuCheck, LuX, LuBanknote, LuTruck } from 'react-icons/lu';
import { get, post, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button, Card, Badge, StatusBadge, Modal, Field, Empty, Spinner, useLoad, useToast, crc, fmtDate } from '../ui.jsx';
import { ProductLines } from './shared.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export default function Purchases() {
  const { can } = useAuth(); const toast = useToast();
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useLoad(() => get(`/api/purchases${status ? `?status=${status}` : ''}`), [status], { poll: 20000 });
  const sup = useLoad(() => get('/api/suppliers'), []);
  const [form, setForm] = useState(null); const [reject, setReject] = useState(null);
  const products = useLoad(() => (form ? get('/api/products') : null), [!!form]);
  const act = async (p, action, reason) => { try { await patch(`/api/purchases/${p.id}`, { action, reason }); toast(`${p.number}: ${action}`, 'ok'); setReject(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const save = async () => {
    try { await post('/api/purchases', { supplier_id: Number(form.supplier_id), number: form.number, issue_date: form.issue_date, description: form.description, items: form.items }); toast('Compra registrada', 'ok'); setForm(null); reload(); }
    catch (e) { if (e.code !== 'FACTURA_DUPLICADA') toast(e.message, 'err'); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Compras e insumos</h1><p>Facturas de repuestos de los {sup.data?.suppliers.length ?? 3} proveedores autorizados. Al aprobar, las cantidades entran automáticamente al inventario.</p></div>
        {can('purchases.create') && <Button variant="primary" icon={LuPlus} onClick={() => setForm({ supplier_id: '', number: '', issue_date: today(), description: '', items: [] })}>Registrar compra</Button>}</div>
      {sup.data && <div className="grid g3" style={{ marginBottom: 16 }}>{sup.data.suppliers.map((s) => <Card key={s.id}><b>{s.name}</b><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{s.tax_id} · {s.phone}<br />{s.contact_email}</div></Card>)}</div>}
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado"><option value="">Todos los estados</option>{['pendiente', 'aprobada', 'pagada', 'rechazada'].map((s) => <option key={s}>{s}</option>)}</select></div>
      <Card flush>{loading && !data ? <Spinner /> : data.purchases.length === 0 ? <Empty>Sin facturas de compra.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Factura</th><th>Proveedor</th><th>Emisión</th><th>Detalle</th><th className="right">Monto</th><th>Estado</th><th>Entrega</th><th /></tr></thead>
          <tbody>{data.purchases.map((p) => <tr key={p.id}><td className="mono"><b>{p.number}</b><br /><small className="muted">{p.source === 'portal' ? 'Portal' : 'Interno'}</small></td><td>{p.supplier_name}</td><td className="nowrap">{fmtDate(p.issue_date + 'T12:00:00Z')}</td>
            <td style={{ fontSize: 13, maxWidth: 280 }}>{p.items.length ? p.items.map((i) => `${i.qty}× ${i.name}`).join(', ') : p.description}</td><td className="right num"><b>{crc(p.amount)}</b></td>
            <td><StatusBadge status={p.status} />{p.reject_reason && <><br /><small className="muted">{p.reject_reason}</small></>}</td>
            <td>{p.delivery_confirmed ? <Badge tone="ok" icon={LuTruck}>Confirmada</Badge> : <span className="muted">—</span>}</td>
            <td>{can('purchases.approve') && <div className="actions" style={{ justifyContent: 'flex-end' }}>
              {p.status === 'pendiente' && <><Button size="sm" variant="primary" icon={LuCheck} onClick={() => act(p, 'aprobar')}>Aprobar</Button><Button size="sm" variant="danger" icon={LuX} onClick={() => setReject({ p, reason: '' })}>Rechazar</Button></>}
              {p.status === 'aprobada' && <Button size="sm" icon={LuBanknote} onClick={() => act(p, 'pagar')}>Registrar pago</Button>}</div>}</td></tr>)}</tbody></table></div>)}</Card>

      {form && <Modal wide title="Registrar compra de insumos" onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!form.supplier_id || !form.number || !form.items.length}>Registrar</Button></>}>
        <div className="callout" style={{ marginBottom: 12 }}>Solo se aceptan los proveedores autorizados. Un número de factura repetido o una factura idéntica se bloquea automáticamente.</div>
        <div className="row"><Field label="Proveedor *"><select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}><option value="">Selecciona…</option>{sup.data?.suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="N.º de factura *"><input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label="Fecha de emisión"><input type="date" max={today()} value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></Field></div>
        {!products.data ? <Spinner /> : <ProductLines withCost products={products.data.products.filter((p) => p.active && p.type !== 'servicio')} lines={form.items} setLines={(fn) => setForm((f) => ({ ...f, items: typeof fn === 'function' ? fn(f.items) : fn }))} />}
        <Field label="Descripción"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></Modal>}
      {reject && <Modal title={`Rechazar ${reject.p.number}`} onClose={() => setReject(null)} footer={<><Button onClick={() => setReject(null)}>Cancelar</Button><Button variant="danger" disabled={reject.reason.length < 5} onClick={() => act(reject.p, 'rechazar', reject.reason)}>Rechazar factura</Button></>}>
        <Field label="Motivo"><textarea rows={3} value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} /></Field></Modal>}
    </>
  );
}
