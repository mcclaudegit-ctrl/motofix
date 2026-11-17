import { useState } from 'react';
import { LuPlus, LuSend, LuCheck, LuReceipt } from 'react-icons/lu';
import { get, post, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Button, Card, StatusBadge, Badge, Modal, Field, Empty, Spinner, useLoad, useToast, crc, fmtDate } from '../ui.jsx';
import { ProductLines } from './shared.jsx';

export default function Quotes() {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, reload } = useLoad(() => get('/api/quotes'), []);
  const [form, setForm] = useState(null);
  const ref = useLoad(() => (form ? get('/api/products') : null), [!!form]);
  const mark = async (q, status) => { try { await patch(`/api/quotes/${q.id}`, { status }); toast(`${q.number}: ${status}`, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const save = async () => {
    try { const r = await post('/api/quotes', { type: form.type, customer_name: form.customer_name, notes: form.notes, items: form.items.map((i) => ({ product_id: i.product_id, qty: i.qty })) }); toast(`${r.number} creada`, 'ok'); setForm(null); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Cotizaciones y precuentas</h1><p>Presupuestos y precuentas de cobro. La facturación final la emite Recepción o Contabilidad.</p></div>
        {can('quotes.create') && <Button variant="primary" icon={LuPlus} onClick={() => setForm({ type: 'cotizacion', customer_name: '', notes: '', items: [] })}>Nueva</Button>}</div>
      <Card flush>{loading && !data ? <Spinner /> : data.quotes.length === 0 ? <Empty>Aún no hay cotizaciones.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Número</th><th>Tipo</th><th>Cliente</th><th>Detalle</th><th className="right">Total (IVA incl.)</th><th>Estado</th><th /></tr></thead>
          <tbody>{data.quotes.map((q) => <tr key={q.id}><td className="mono"><b>{q.number}</b><br /><small className="muted">{fmtDate(q.created_at)}</small></td><td><Badge tone={q.type === 'cotizacion' ? 'brand' : 'dark'}>{q.type === 'cotizacion' ? 'Cotización' : 'Precuenta'}</Badge></td>
            <td>{q.customer_name || <span className="muted">—</span>}<br /><small className="muted">{q.created_by_name}</small></td><td style={{ fontSize: 13, maxWidth: 300 }}>{q.items.map((i) => `${i.qty}× ${i.description}`).join(', ')}</td>
            <td className="right num"><b>{crc(q.total)}</b></td><td><StatusBadge status={q.status} /></td>
            <td><div className="actions" style={{ justifyContent: 'flex-end' }}>
              {can('quotes.create') && q.status === 'borrador' && <Button size="sm" icon={LuSend} onClick={() => mark(q, 'enviada')}>Enviar</Button>}
              {can('quotes.create') && q.status === 'enviada' && <Button size="sm" icon={LuCheck} onClick={() => mark(q, 'aceptada')}>Aceptada</Button>}
              {can('invoices.create') && q.status !== 'facturada' && <Link className="btn sm dark" to={`/facturas/nueva?quote=${q.id}`}><LuReceipt /> Facturar</Link>}</div></td></tr>)}</tbody></table></div>)}</Card>
      {form && <Modal wide title="Nueva cotización / precuenta" onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!form.customer_name || !form.items.length}>Crear</Button></>}>
        <div className="row"><Field label="Tipo"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="cotizacion">Cotización</option><option value="precuenta">Precuenta de cobro</option></select></Field>
          <Field label="Cliente *"><input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} /></Field></div>
        {!ref.data ? <Spinner /> : <ProductLines products={ref.data.products.filter((p) => p.active)} lines={form.items} setLines={(fn) => setForm((f) => ({ ...f, items: typeof fn === 'function' ? fn(f.items) : fn }))} priceOf={(p) => p?.price || 0} label="Agregar del catálogo…" />}
        <Field label="Notas"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field></Modal>}
    </>
  );
}
