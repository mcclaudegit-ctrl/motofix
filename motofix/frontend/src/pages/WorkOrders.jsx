import { useState } from 'react';
import { LuPlus, LuPlay, LuCheck, LuBan, LuReceipt } from 'react-icons/lu';
import { get, post, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Button, Card, StatusBadge, Modal, Field, Empty, Spinner, useLoad, useToast, crc, fmtDate } from '../ui.jsx';
import { ProductLines } from './shared.jsx';

export default function WorkOrders() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useLoad(() => get(`/api/workorders${status ? `?status=${status}` : ''}`), [status], { poll: 20000 });
  const [form, setForm] = useState(null);
  const change = async (w, s) => { try { await patch(`/api/workorders/${w.id}`, { status: s }); toast(`${w.number}: ${s.replace('_', ' ')}`, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <div className="page-head"><div><h1>Órdenes de trabajo</h1><p>Cada orden es el «contrato» que respalda la factura (NIIF 15): el ingreso se reconoce al completarla.</p></div>
        {can('workorders.create') && <Button variant="primary" icon={LuPlus} onClick={() => setForm({ customer_id: '', motorcycle: '', plate: '', description: '', labor_amount: 0, parts: [] })}>Nueva orden</Button>}</div>
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado"><option value="">Todos los estados</option>{['abierta', 'en_proceso', 'completada', 'facturada', 'cancelada'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></div>
      <Card flush>
        {loading && !data ? <Spinner /> : data.workorders.length === 0 ? <Empty>Sin órdenes.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Orden</th><th>Cliente / moto</th><th>Trabajo</th><th>Repuestos usados</th><th className="right">Valor</th><th>Estado</th><th /></tr></thead>
            <tbody>{data.workorders.map((w) => (
              <tr key={w.id}><td className="mono"><b>{w.number}</b><br /><small className="muted">{fmtDate(w.created_at)}</small></td>
                <td>{w.customer_name}<br /><small className="muted">{w.motorcycle} {w.plate && `· ${w.plate}`}</small></td><td style={{ maxWidth: 260 }}>{w.description}</td>
                <td style={{ fontSize: 13 }}>{w.parts.length ? w.parts.map((p) => `${p.qty}× ${p.name}`).join(', ') : <span className="muted">—</span>}</td>
                <td className="right num">{crc(w.expected)}</td>
                <td><StatusBadge status={w.status} />{w.invoice_number && <><br /><Link to={`/facturas/${w.invoice_id}`} className="mono" style={{ fontSize: 12 }}>{w.invoice_number}</Link></>}</td>
                <td><div className="actions" style={{ justifyContent: 'flex-end' }}>
                  {can('workorders.update') && w.status === 'abierta' && <Button size="sm" icon={LuPlay} onClick={() => change(w, 'en_proceso')}>Iniciar</Button>}
                  {can('workorders.update') && ['abierta', 'en_proceso'].includes(w.status) && <Button size="sm" variant="primary" icon={LuCheck} onClick={() => change(w, 'completada')}>Completar</Button>}
                  {can('workorders.update') && ['abierta', 'en_proceso'].includes(w.status) && <Button size="sm" variant="ghost" icon={LuBan} aria-label="Cancelar orden" onClick={() => change(w, 'cancelada')} />}
                  {can('invoices.create') && w.status === 'completada' && <Link className="btn sm dark" to={`/facturas/nueva?wo=${w.id}`}><LuReceipt /> Facturar</Link>}
                </div></td></tr>))}</tbody></table></div>
        )}
      </Card>
      {form && <WOForm form={form} setForm={setForm} onDone={() => { setForm(null); reload(); }} />}
    </>
  );
}

function WOForm({ form, setForm, onDone }) {
  const toast = useToast();
  const { data: ref } = useLoad(async () => ({ customers: (await get('/api/customers')).customers, products: (await get('/api/products?type=repuesto')).products.concat((await get('/api/products?type=insumo')).products) }), []);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    try { await post('/api/workorders', { ...form, customer_id: Number(form.customer_id), labor_amount: Number(form.labor_amount) || 0, parts: form.parts.map((p) => ({ product_id: p.product_id, qty: p.qty })) }); toast('Orden creada', 'ok'); onDone(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal wide title="Nueva orden de trabajo" onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!form.customer_id || !form.motorcycle || form.description.length < 5}>Crear orden</Button></>}>
      {!ref ? <Spinner /> : <>
        <div className="row">
          <Field label="Cliente *"><select value={form.customer_id} onChange={set('customer_id')}><option value="">Selecciona…</option>{ref.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Motocicleta *"><input value={form.motorcycle} onChange={set('motorcycle')} placeholder="Marca y modelo" /></Field>
          <Field label="Placa"><input value={form.plate} onChange={set('plate')} /></Field>
        </div>
        <Field label="Descripción del trabajo *"><textarea rows={2} value={form.description} onChange={set('description')} /></Field>
        <Field label="Mano de obra (₡)"><input type="number" min={0} value={form.labor_amount} onChange={set('labor_amount')} /></Field>
        <Field label="Repuestos e insumos usados" hint="Se comparan contra lo facturado para detectar discrepancias.">
          <ProductLines products={ref.products} lines={form.parts} setLines={(fn) => setForm((f) => ({ ...f, parts: typeof fn === 'function' ? fn(f.parts) : fn }))} priceOf={(p) => p?.price || 0} />
        </Field></>}
    </Modal>
  );
}
