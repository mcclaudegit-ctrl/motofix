import { useState } from 'react';
import { LuPlus, LuSearch, LuPencil, LuSlidersHorizontal } from 'react-icons/lu';
import { get, post, put } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button, Card, Badge, Modal, Field, Empty, Spinner, useLoad, useToast, useDebounced, crc, fmtDate } from '../ui.jsx';

const TYPES = { repuesto: 'Repuesto', insumo: 'Insumo', servicio: 'Servicio' };

export default function Inventory() {
  const { can } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState('catalogo'); const [q, setQ] = useState(''); const [type, setType] = useState(''); const [low, setLow] = useState(false);
  const dq = useDebounced(q);
  const { data, loading, reload } = useLoad(() => get(`/api/products?q=${encodeURIComponent(dq)}&type=${type}${low ? '&low=1' : ''}`), [dq, type, low]);
  const mv = useLoad(() => (tab === 'movimientos' ? get('/api/inventory/movements') : null), [tab]);
  const [form, setForm] = useState(null); const [adj, setAdj] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    const body = { ...form, price: Number(form.price), cost: Number(form.cost) || 0, min_stock: Number(form.min_stock) || 0, stock: Number(form.stock) || 0 };
    try { form.id ? await put(`/api/products/${form.id}`, body) : await post('/api/products', body); toast('Producto guardado', 'ok'); setForm(null); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const doAdjust = async () => { try { await post(`/api/products/${adj.p.id}/adjust`, { delta: Number(adj.delta), note: adj.note }); toast('Stock ajustado', 'ok'); setAdj(null); reload(); } catch (e) { toast(e.message, 'err'); } };

  return (
    <>
      <div className="page-head"><div><h1>Inventario y catálogo</h1><p>El stock se descuenta automáticamente al facturar y se repone al aprobar compras o anular facturas.</p></div>
        {can('inventory.edit') && <Button variant="primary" icon={LuPlus} onClick={() => setForm({ sku: '', name: '', type: 'repuesto', price: 0, cost: 0, stock: 0, min_stock: 0 })}>Nuevo producto</Button>}</div>
      <div className="tabs"><button className={`tab ${tab === 'catalogo' ? 'on' : ''}`} onClick={() => setTab('catalogo')}>Catálogo</button><button className={`tab ${tab === 'movimientos' ? 'on' : ''}`} onClick={() => setTab('movimientos')}>Movimientos de stock</button></div>
      {tab === 'catalogo' ? <>
        <div className="toolbar"><div className="search"><LuSearch /><input placeholder="Buscar por nombre o SKU" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" /></div>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo"><option value="">Todos los tipos</option>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label className="chk"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Solo stock bajo</label></div>
        <Card flush>{loading && !data ? <Spinner /> : data.products.length === 0 ? <Empty>Sin productos.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>SKU</th><th>Producto</th><th>Tipo</th><th className="right">Stock</th><th className="right">Precio</th>{data.showCost && <th className="right">Costo</th>}<th /></tr></thead>
            <tbody>{data.products.map((p) => { const isLow = p.type !== 'servicio' && p.stock <= p.min_stock; return (
              <tr key={p.id} style={p.active ? undefined : { opacity: 0.5 }}><td className="mono">{p.sku}</td><td><b>{p.name}</b>{!p.active && <> <Badge>Inactivo</Badge></>}</td><td>{TYPES[p.type]}</td>
                <td className="right num">{p.type === 'servicio' ? <span className="muted">—</span> : <>{isLow ? <Badge tone="danger">{p.stock}</Badge> : <b>{p.stock}</b>} <small className="muted">/ mín. {p.min_stock}</small></>}</td>
                <td className="right num">{crc(p.price)}</td>{data.showCost && <td className="right num muted">{crc(p.cost)}</td>}
                <td className="right"><div className="actions" style={{ justifyContent: 'flex-end' }}>
                  {can('inventory.adjust') && p.type !== 'servicio' && <Button size="sm" icon={LuSlidersHorizontal} onClick={() => setAdj({ p, delta: 0, note: '' })}>Ajustar</Button>}
                  {can('inventory.edit') && <Button size="sm" variant="ghost" icon={LuPencil} aria-label="Editar" onClick={() => setForm({ ...p })} />}</div></td></tr>); })}</tbody></table></div>)}</Card></> : (
        <Card flush>{mv.loading && !mv.data ? <Spinner /> : (
          <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Producto</th><th className="right">Cantidad</th><th>Motivo</th><th>Usuario</th><th>Nota</th></tr></thead>
            <tbody>{mv.data?.movements.map((m) => <tr key={m.id}><td className="nowrap">{fmtDate(m.created_at, true)}</td><td>{m.product_name}</td><td className="right num"><b style={{ color: m.qty < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.qty > 0 ? '+' : ''}{m.qty}</b></td><td><Badge tone={{ venta: 'brand', compra: 'ok', anulacion: 'warn', ajuste: '' }[m.reason]}>{m.reason}</Badge></td><td className="muted">{m.user_name}</td><td className="muted">{m.note}</td></tr>)}</tbody></table></div>)}</Card>)}

      {form && <Modal title={form.id ? 'Editar producto' : 'Nuevo producto'} onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!form.sku || !form.name}>Guardar</Button></>}>
        <div className="row"><Field label="SKU *"><input value={form.sku} onChange={set('sku')} /></Field><Field label="Tipo"><select value={form.type} onChange={set('type')}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field></div>
        <Field label="Nombre *"><input value={form.name} onChange={set('name')} /></Field>
        <div className="row"><Field label="Precio (₡)"><input type="number" min={0} value={form.price} onChange={set('price')} /></Field>{can('inventory.view_cost') && <Field label="Costo (₡)"><input type="number" min={0} value={form.cost} onChange={set('cost')} /></Field>}<Field label="Stock mínimo"><input type="number" min={0} value={form.min_stock} onChange={set('min_stock')} /></Field>{!form.id && form.type !== 'servicio' && <Field label="Stock inicial"><input type="number" min={0} value={form.stock} onChange={set('stock')} /></Field>}</div>
        {form.id && <label className="chk"><input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked ? 1 : 0 })} /> Activo en catálogo</label>}</Modal>}
      {adj && <Modal title={`Ajustar stock · ${adj.p.name}`} onClose={() => setAdj(null)} footer={<><Button onClick={() => setAdj(null)}>Cancelar</Button><Button variant="primary" disabled={!Number(adj.delta) || adj.note.length < 5} onClick={doAdjust}>Aplicar ajuste</Button></>}>
        <p className="muted">Stock actual: <b>{adj.p.stock}</b>. Usa números negativos para mermas. Queda en bitácora.</p>
        <Field label="Cantidad (+/−)"><input type="number" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} /></Field>
        <Field label="Motivo *"><input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Conteo físico, merma, daño…" /></Field></Modal>}
    </>
  );
}
