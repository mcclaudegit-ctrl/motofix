import { useState } from 'react';
import { LuUpload, LuTruck, LuClock, LuBanknote, LuCircleCheck, LuCircleX } from 'react-icons/lu';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button, Card, Badge, StatusBadge, Modal, Field, Empty, Spinner, Kpi, useLoad, useToast, crc, fmtDate } from '../ui.jsx';
import { ProductLines } from './shared.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export default function Portal() {
  const { user } = useAuth(); const toast = useToast();
  const isSupplier = !!user.supplier_id;
  const [sid, setSid] = useState('');
  const { data, loading, reload } = useLoad(() => get(`/api/portal/summary${sid ? `?supplier_id=${sid}` : ''}`), [sid], { poll: 20000 });
  const [form, setForm] = useState(null);
  const cat = useLoad(() => (form ? get('/api/portal/catalog') : null), [!!form]);
  const save = async () => {
    try { await post('/api/portal/invoices', { number: form.number, issue_date: form.issue_date, description: form.description, ...(form.items.length ? { items: form.items } : { amount: Number(form.amount) }) }); toast('Factura cargada. Quedó en revisión.', 'ok'); setForm(null); reload(); }
    catch (e) { if (e.code !== 'FACTURA_DUPLICADA') toast(e.message, 'err'); }
  };
  const confirm = async (i) => { try { await post(`/api/portal/invoices/${i.id}/confirm-delivery`); toast('Entrega confirmada', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  if (loading && !data) return <Spinner />;
  const a = data.accounts;
  return (
    <>
      <div className="page-head"><div><h1>{data.supplier ? data.supplier.name : 'Portal de proveedores'}</h1><p>{isSupplier ? 'Carga tus facturas de repuestos e insumos, consulta tu estado de cuentas por cobrar y confirma entregas.' : 'Vista de supervisión de los proveedores autorizados (solo lectura).'}</p></div>
        {isSupplier ? <Button variant="primary" icon={LuUpload} onClick={() => setForm({ number: '', issue_date: today(), description: '', amount: '', items: [] })}>Cargar factura</Button>
          : <select value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Proveedor"><option value="">Todos los proveedores</option>{data.suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi label="En revisión" icon={LuClock} value={crc(a.en_revision.amount)} sub={`${a.en_revision.count} facturas`} />
        <Kpi label="Por cobrar" icon={LuBanknote} value={crc(a.por_cobrar.amount)} sub={`${a.por_cobrar.count} aprobadas, pendientes de pago`} />
        <Kpi label="Cobrado" icon={LuCircleCheck} value={crc(a.cobrado.amount)} sub={`${a.cobrado.count} facturas pagadas`} />
        <Kpi label="Rechazadas" icon={LuCircleX} value={a.rechazado.count} sub={crc(a.rechazado.amount)} />
      </div>
      <Card title="Estado de cuenta" icon={LuTruck} flush>{data.invoices.length === 0 ? <Empty>Aún no hay facturas.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Factura</th>{!isSupplier && <th>Proveedor</th>}<th>Emisión</th><th>Detalle</th><th className="right">Monto</th><th>Estado</th><th>Entrega</th></tr></thead>
          <tbody>{data.invoices.map((i) => <tr key={i.id}><td className="mono"><b>{i.number}</b></td>{!isSupplier && <td>{i.supplier_name}</td>}<td className="nowrap">{fmtDate(i.issue_date + 'T12:00:00Z')}</td>
            <td style={{ fontSize: 13, maxWidth: 300 }}>{i.items.length ? i.items.map((x) => `${x.qty}× ${x.name}`).join(', ') : i.description}</td><td className="right num"><b>{crc(i.amount)}</b></td>
            <td><StatusBadge status={i.status} />{i.reject_reason && <><br /><small className="muted">{i.reject_reason}</small></>}</td>
            <td>{i.delivery_confirmed ? <Badge tone="ok" icon={LuTruck}>Confirmada {fmtDate(i.delivered_at)}</Badge> : isSupplier && i.status !== 'rechazada' ? <Button size="sm" icon={LuTruck} onClick={() => confirm(i)}>Confirmar entrega</Button> : <span className="muted">Pendiente</span>}</td></tr>)}</tbody></table></div>)}</Card>

      {form && <Modal wide title="Cargar factura de insumos" onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!form.number || (!form.items.length && !Number(form.amount))}>Enviar a MotoFix</Button></>}>
        <div className="row"><Field label="N.º de factura *"><input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label="Fecha de emisión"><input type="date" max={today()} value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></Field></div>
        <Field label="Descripción"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Ítems entregados" hint="Al aprobarse, las cantidades ingresan al inventario. Si no detallas ítems, indica el monto total.">
          {!cat.data ? <Spinner /> : <ProductLines withCost products={cat.data.products} lines={form.items} setLines={(fn) => setForm((f) => ({ ...f, items: typeof fn === 'function' ? fn(f.items) : fn }))} />}</Field>
        {!form.items.length && <Field label="Monto total (₡)"><input type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>}</Modal>}
    </>
  );
}
