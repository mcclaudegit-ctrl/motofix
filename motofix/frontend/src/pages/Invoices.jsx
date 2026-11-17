import { useEffect, useMemo, useState } from 'react';
import { LuPlus, LuSearch, LuTriangleAlert, LuBan, LuCircleCheck, LuPercent, LuTrash2 as LuTrash, LuReceipt, LuCopy } from 'react-icons/lu';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link, useRouter } from '../lib/router.jsx';
import { Button, Card, Badge, StatusBadge, SevBadge, Modal, Field, Empty, Spinner, SecurityModal, useLoad, useToast, useDebounced, crc, fmtDate } from '../ui.jsx';

const KIND = { venta: 'Venta', servicio: 'Servicio' };

export function InvoiceList() {
  const { can } = useAuth();
  const { navigate } = useRouter();
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [kind, setKind] = useState(''); const [flagged, setFlagged] = useState(false);
  const dq = useDebounced(q);
  const { data, loading, error } = useLoad(() => get(`/api/invoices?limit=300&q=${encodeURIComponent(dq)}&status=${status}&kind=${kind}${flagged ? '&flagged=1' : ''}`), [dq, status, kind, flagged], { poll: 15000 });
  return (
    <>
      <div className="page-head">
        <div><h1>Facturas</h1><p>Facturas de venta y servicios mecánicos. Las filas en rojo tienen alertas abiertas del motor de IA.</p></div>
        {can('invoices.create') && <Link to="/facturas/nueva" className="btn primary"><LuPlus /> Nueva factura</Link>}
      </div>
      <div className="toolbar">
        <div className="search"><LuSearch /><input placeholder="Buscar por consecutivo o cliente" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado"><option value="">Todos los estados</option><option value="pendiente">Pendientes</option><option value="pagada">Pagadas</option><option value="anulada">Anuladas</option></select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo"><option value="">Venta y servicio</option><option value="venta">Ventas</option><option value="servicio">Servicios</option></select>
        <label className="chk"><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Solo con alertas</label>
        <span className="muted" style={{ marginLeft: 'auto' }}>{data ? `${data.total} resultado(s)` : ''}</span>
      </div>
      <Card flush>
        {loading && !data ? <Spinner /> : error ? <Empty>{error.message}</Empty> : data.invoices.length === 0 ? <Empty>No hay facturas con esos filtros.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Consecutivo</th><th>Fecha</th><th>Cliente</th><th>Tipo</th><th className="right">Total</th><th>Estado</th><th>Alertas</th><th>Emitida por</th></tr></thead>
            <tbody>{data.invoices.map((i) => (
              <tr key={i.id} className={`clickable ${i.alerts && i.status !== 'anulada' ? 'flag' : ''}`} onClick={() => navigate(`/facturas/${i.id}`)}>
                <td className="mono"><b>{i.number}</b></td><td className="nowrap">{fmtDate(i.created_at, true)}</td><td>{i.customer_name || <span className="muted">Contado</span>}</td>
                <td>{KIND[i.kind]}</td><td className="right num"><b>{crc(i.total)}</b></td>
                <td><StatusBadge status={i.status} />{i.pending_requests > 0 && <> <Badge tone="warn">Solicitud</Badge></>}</td>
                <td>{i.alerts > 0 && i.status !== 'anulada' ? <Badge tone="danger" icon={LuTriangleAlert}>{i.alerts}</Badge> : <span className="muted">—</span>}</td>
                <td className="muted">{i.created_by_name}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

export function InvoiceDetail({ params }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data: inv, loading, error, reload } = useLoad(() => get(`/api/invoices/${params.id}`), [params.id]);
  const [dlg, setDlg] = useState(null); const [reason, setReason] = useState(''); const [pct, setPct] = useState(10); const [busy, setBusy] = useState(false);
  if (loading && !inv) return <Spinner />;
  if (error && !inv) return <Empty>{error.message}</Empty>;

  const act = async (fn, okMsg) => { setBusy(true); try { await fn(); toast(okMsg, 'ok'); setDlg(null); setReason(''); reload(); } catch (e) { if (![403, 405].includes(e.status)) toast(e.message, 'err'); setDlg(null); reload(); } finally { setBusy(false); } };
  const live = inv.status !== 'anulada';
  const canVoidDirect = can('invoices.void'); const canRequest = can('approvals.request');
  const open = inv.anomalies.filter((a) => a.status === 'abierta');

  return (
    <>
      <div className="page-head">
        <div><div className="muted" style={{ marginBottom: 4 }}><Link to="/facturas">← Facturas</Link></div>
          <h1><span className="mono">{inv.number}</span> <StatusBadge status={inv.status} /></h1></div>
        {live && (
          <div className="actions">
            {inv.status === 'pendiente' && can('invoices.pay') && <Button variant="primary" icon={LuCircleCheck} onClick={() => act(() => post(`/api/invoices/${inv.id}/pay`), 'Factura marcada como pagada')}>Registrar cobro</Button>}
            {inv.status === 'pendiente' && inv.discount === 0 && canRequest && <Button icon={LuPercent} onClick={() => setDlg('discount')}>Solicitar descuento</Button>}
            {canVoidDirect ? <Button variant="danger" icon={LuBan} onClick={() => setDlg('void')}>Anular factura</Button>
              : canRequest ? <Button variant="danger" icon={LuBan} onClick={() => setDlg('request')}>Solicitar anulación</Button>
              : <Button locked onClick={() => post(`/api/invoices/${inv.id}/void`, { reason: 'Intento de anulación desde la interfaz' }).catch(() => {})}>Anular factura</Button>}
          </div>
        )}
      </div>

      {open.length > 0 && live && (
        <div className="callout danger" style={{ marginBottom: 16, flexDirection: 'column', gap: 8 }}>
          <b><LuTriangleAlert style={{ verticalAlign: -3 }} /> {open.length} alerta(s) del motor de IA en esta factura</b>
          {open.map((a) => <div key={a.id}><SevBadge sev={a.severity} /> <b>{a.title}</b> — {a.detail}</div>)}
        </div>
      )}

      <div className="grid g-main">
        <Card flush>
          <div className="paper">
            <dl className="kv" style={{ marginBottom: 18 }}>
              <dt>Cliente</dt><dd>{inv.customer_name || 'Cliente de contado'} {inv.customer_id_number && <span className="muted">· {inv.customer_id_number}</span>}</dd>
              <dt>Tipo</dt><dd>{KIND[inv.kind]}{inv.work_order_number && <> · orden <span className="mono">{inv.work_order_number}</span></>}</dd>
              <dt>Emitida</dt><dd>{fmtDate(inv.created_at, true)} por {inv.created_by_name}</dd>
              {inv.paid_at && <><dt>Cobrada</dt><dd>{fmtDate(inv.paid_at, true)}</dd></>}
              {inv.status === 'anulada' && <><dt>Anulación</dt><dd>{fmtDate(inv.voided_at, true)} — {inv.void_reason}</dd></>}
              {inv.override_reason && <><dt>Duplicado autorizado</dt><dd>{inv.override_reason}</dd></>}
              {inv.notes && <><dt>Notas</dt><dd>{inv.notes}</dd></>}
            </dl>
            <table className="lines"><thead><tr><th>Descripción</th><th className="right">Cant.</th><th className="right">Precio</th><th className="right">Total</th></tr></thead>
              <tbody>{inv.items.map((it) => <tr key={it.id}><td>{it.description}</td><td className="right num">{it.qty}</td><td className="right num">{crc(it.unit_price)}</td><td className="right num">{crc(it.line_total)}</td></tr>)}</tbody></table>
            <div className="totals num" style={{ marginTop: 14 }}>
              <div><span>Subtotal</span><span>{crc(inv.subtotal)}</span></div>
              {inv.discount > 0 && <div><span>Descuento</span><span>−{crc(inv.discount)}</span></div>}
              <div><span>IVA 13%</span><span>{crc(inv.tax)}</span></div>
              <div className="grand"><span>Total</span><span>{crc(inv.total)}</span></div>
            </div>
          </div>
        </Card>
        <Card title="Solicitudes de aprobación" icon={LuCircleCheck} flush>
          {inv.approvals.length === 0 ? <Empty>Sin solicitudes</Empty> : inv.approvals.map((a) => (
            <div key={a.id} className="alert-item"><div style={{ flex: 1 }}><b>{a.type === 'anulacion' ? 'Anulación' : `Descuento ${a.pct}%`}</b> <StatusBadge status={a.status} /><p>{a.reason}</p>
              <small className="muted">Solicitó {a.requested_by_name} · {fmtDate(a.created_at, true)}{a.resolved_by_name && ` · resolvió ${a.resolved_by_name}`}</small></div></div>
          ))}
        </Card>
      </div>

      {dlg === 'void' && <Modal title="Anular factura" onClose={() => setDlg(null)} footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="danger" disabled={busy || reason.length < 5} onClick={() => act(() => post(`/api/invoices/${inv.id}/void`, { reason }), 'Factura anulada y stock restituido')}>Confirmar anulación</Button></>}>
        <p className="muted">Se restituirá el stock y la orden de trabajo vuelve a «completada». El consecutivo se conserva.</p>
        <Field label="Motivo"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></Modal>}
      {dlg === 'request' && <Modal title="Solicitar anulación" onClose={() => setDlg(null)} footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="primary" disabled={busy || reason.length < 10} onClick={() => act(() => post('/api/approvals', { type: 'anulacion', invoice_id: inv.id, reason }), 'Solicitud enviada a Gerencia')}>Enviar solicitud</Button></>}>
        <p className="muted">Un Gerente o Administrador debe aprobarla.</p><Field label="Motivo (mín. 10 caracteres)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></Modal>}
      {dlg === 'discount' && <Modal title="Solicitar descuento" onClose={() => setDlg(null)} footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="primary" disabled={busy || reason.length < 10} onClick={() => act(() => post('/api/approvals', { type: 'descuento', invoice_id: inv.id, pct: Number(pct), reason }), 'Solicitud enviada a Gerencia')}>Enviar solicitud</Button></>}>
        <Field label="Descuento (%)"><input type="number" min={1} max={50} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
        <Field label="Motivo (mín. 10 caracteres)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></Modal>}
    </>
  );
}

export function InvoiceNew() {
  const { can } = useAuth();
  const { navigate, query } = useRouter();
  const toast = useToast();
  const { data: ref } = useLoad(async () => {
    const [products, customers, wos, next] = await Promise.all([
      can('inventory.view') ? get('/api/products') : { products: [] }, can('customers.view') ? get('/api/customers') : { customers: [] },
      can('workorders.view') ? get('/api/workorders?status=completada') : { workorders: [] }, get('/api/invoices/next-number'),
    ]);
    const quote = query.get('quote') && can('quotes.view') ? (await get('/api/quotes')).quotes.find((q) => q.id === Number(query.get('quote'))) : null;
    return { products: products.products.filter((p) => p.active), customers: customers.customers, wos: wos.workorders, next: next.number, quote };
  }, []);

  const [kind, setKind] = useState('venta'); const [customerId, setCustomerId] = useState(''); const [woId, setWoId] = useState('');
  const [lines, setLines] = useState([]); const [pct, setPct] = useState(0); const [paid, setPaid] = useState(false); const [notes, setNotes] = useState('');
  const [pick, setPick] = useState(''); const [busy, setBusy] = useState(false); const [dup, setDup] = useState(null); const [justify, setJustify] = useState(null);

  const byId = useMemo(() => Object.fromEntries((ref?.products || []).map((p) => [p.id, p])), [ref]);
  const addProduct = (id, qty = 1) => { const p = byId[id]; if (!p) return; setLines((l) => { const ex = l.find((x) => x.product_id === p.id); return ex ? l.map((x) => (x === ex ? { ...x, qty: x.qty + qty } : x)) : [...l, { key: Math.random(), product_id: p.id, description: p.name, qty, unit_price: p.price, type: p.type, stock: p.stock }]; }); };

  useEffect(() => { // precarga desde orden de trabajo o cotización
    if (!ref) return;
    const wo = query.get('wo') && ref.wos.find((w) => w.id === Number(query.get('wo')));
    if (wo) pickWO(String(wo.id));
    if (ref.quote) { setCustomerId(ref.quote.customer_id ? String(ref.quote.customer_id) : ''); setLines(ref.quote.items.map((it) => ({ key: Math.random(), product_id: it.product_id, description: it.description, qty: it.qty, unit_price: it.unit_price, type: byId[it.product_id]?.type, stock: byId[it.product_id]?.stock, custom: !it.product_id }))); setNotes(`Desde ${ref.quote.number}`); }
  }, [ref]); // eslint-disable-line

  function pickWO(id) {
    setWoId(id);
    const wo = ref.wos.find((w) => w.id === Number(id));
    if (!wo) return;
    setKind('servicio'); setCustomerId(String(wo.customer_id));
    setLines([...(wo.labor_amount ? [{ key: Math.random(), product_id: null, custom: true, description: `Mano de obra · ${wo.description}`.slice(0, 150), qty: 1, unit_price: wo.labor_amount }] : []),
      ...wo.parts.map((p) => ({ key: Math.random(), product_id: p.product_id, description: p.name, qty: p.qty, unit_price: p.unit_price, type: byId[p.product_id]?.type, stock: byId[p.product_id]?.stock }))]);
  }

  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const discount = Math.round((subtotal * pct) / 100); const tax = Math.round((subtotal - discount) * 0.13); const total = subtotal - discount + tax;

  const submit = async (override) => {
    setBusy(true);
    try {
      const inv = await post('/api/invoices', {
        kind, customer_id: customerId ? Number(customerId) : null, work_order_id: woId ? Number(woId) : null, quote_id: ref?.quote?.id, notes: notes || null, discount_pct: Number(pct) || 0, paid,
        items: lines.map((l) => (l.product_id ? { product_id: l.product_id, qty: Number(l.qty) } : { description: l.description, qty: Number(l.qty), unit_price: Number(l.unit_price) })),
        ...(override ? { override_duplicate: true, override_reason: override } : {}),
      }, { quiet: true });
      toast(`Factura ${inv.number} emitida`, 'ok'); navigate(`/facturas/${inv.id}`);
    } catch (e) {
      if (e.code === 'FACTURA_DUPLICADA') setDup(e);
      else if (e.code === 'PERMISO_DENEGADO') setDup({ ...e, forceSecurity: true });
      else toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  if (!ref) return <Spinner />;
  const wosFree = ref.wos;
  return (
    <>
      <div className="page-head"><div><div className="muted" style={{ marginBottom: 4 }}><Link to="/facturas">← Facturas</Link></div><h1>Nueva factura</h1>
        <p>Consecutivo asignado automáticamente: <b className="mono">{ref.next}</b>. El sistema bloquea facturas duplicadas y descuenta el inventario al emitir.</p></div></div>
      <div className="grid g-main">
        <Card title="Datos y líneas" icon={LuReceipt}>
          <div className="row">
            <Field label="Tipo"><select value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value === 'venta') setWoId(''); }} disabled={!!woId}><option value="venta">Venta de mostrador</option><option value="servicio">Servicio mecánico</option></select></Field>
            <Field label="Orden de trabajo completada" hint={wosFree.length ? undefined : 'No hay órdenes completadas por facturar'}><select value={woId} onChange={(e) => (e.target.value ? pickWO(e.target.value) : setWoId(''))}><option value="">— Sin orden —</option>{wosFree.map((w) => <option key={w.id} value={w.id}>{w.number} · {w.customer_name}</option>)}</select></Field>
            <Field label={kind === 'servicio' ? 'Cliente *' : 'Cliente (opcional)'}><select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={!!woId}><option value="">{kind === 'servicio' ? 'Selecciona…' : 'Cliente de contado'}</option>{ref.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          </div>
          <div className="table-wrap"><table className="lines"><thead><tr><th>Descripción</th><th>Cant.</th><th className="right">Precio</th><th className="right">Total</th><th /></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.key}><td>{l.custom ? <input value={l.description} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, description: e.target.value } : x)))} style={{ width: '100%' }} /> : <>{l.description} {l.type && l.type !== 'servicio' && l.stock != null && l.qty > l.stock && <Badge tone="danger">stock {l.stock}</Badge>}</>}</td>
                <td><input type="number" min={1} value={l.qty} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} /></td>
                <td className="right num">{l.custom ? <input type="number" min={0} value={l.unit_price} style={{ width: 110 }} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, unit_price: Number(e.target.value) || 0 } : x)))} /> : crc(l.unit_price)}</td>
                <td className="right num">{crc(l.qty * l.unit_price)}</td>
                <td><Button variant="ghost" size="sm" onClick={() => setLines(lines.filter((x) => x !== l))} aria-label="Quitar"><LuTrash /></Button></td></tr>))}
              {lines.length === 0 && <tr><td colSpan={5}><Empty>Agrega productos o servicios del catálogo.</Empty></td></tr>}</tbody></table></div>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 220 }} aria-label="Producto">
              <option value="">Agregar del catálogo…</option>
              {['servicio', 'repuesto', 'insumo'].map((t) => <optgroup key={t} label={t[0].toUpperCase() + t.slice(1) + 's'}>{ref.products.filter((p) => p.type === t).map((p) => <option key={p.id} value={p.id}>{p.name} — {crc(p.price)}{t !== 'servicio' ? ` (stock ${p.stock})` : ''}</option>)}</optgroup>)}
            </select>
            <Button disabled={!pick} onClick={() => { addProduct(Number(pick)); setPick(''); }} icon={LuPlus}>Agregar</Button>
            <Button onClick={() => setLines([...lines, { key: Math.random(), product_id: null, custom: true, description: '', qty: 1, unit_price: 0 }])}>Línea libre</Button>
          </div>
        </Card>
        <Card title="Resumen" icon={LuCircleCheck}>
          <Field label="Descuento (%)" hint={can('invoices.discount') ? 'Máx. 50%. Descuentos ≥ 15% generan alerta de IA.' : 'Requiere autorización: solicita el descuento a Gerencia desde la factura emitida.'}>
            {can('invoices.discount') ? <input type="number" min={0} max={50} value={pct} onChange={(e) => setPct(e.target.value)} />
              : <Button locked onClick={() => post('/api/invoices', { kind, discount_pct: 10, items: [] }).catch(() => {})}>Aplicar descuento</Button>}
          </Field>
          <Field label="Notas"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} /></Field>
          {can('invoices.pay') && <label className="chk" style={{ marginBottom: 14 }}><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Cobrada en caja</label>}
          <div className="totals num" style={{ width: '100%' }}>
            <div><span>Subtotal</span><span>{crc(subtotal)}</span></div>
            {discount > 0 && <div><span>Descuento</span><span>−{crc(discount)}</span></div>}
            <div><span>IVA 13%</span><span>{crc(tax)}</span></div>
            <div className="grand"><span>Total</span><span>{crc(total)}</span></div>
          </div>
          <Button variant="primary" icon={LuReceipt} style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} disabled={busy || lines.length === 0 || (kind === 'servicio' && !customerId)} onClick={() => submit()}>Emitir factura</Button>
        </Card>
      </div>

      {dup && dup.forceSecurity && <SecurityModal event={dup.body} onClose={() => setDup(null)} />}
      {dup && !dup.forceSecurity && (
        <SecurityModal event={{ ...dup.body, error: 'FACTURA_DUPLICADA' }} onClose={() => setDup(null)}
          extra={can('approvals.resolve') ? <Button icon={LuCopy} onClick={() => { setDup(null); setJustify(''); }}>Autorizar de todos modos</Button> : null} />
      )}
      {justify !== null && (
        <Modal title="Autorizar factura duplicada" onClose={() => setJustify(null)} footer={<><Button onClick={() => setJustify(null)}>Cancelar</Button><Button variant="primary" disabled={justify.length < 10 || busy} onClick={() => { const j = justify; setJustify(null); submit(j); }}>Emitir con justificación</Button></>}>
          <p className="muted">Quedará registrado en la bitácora y el motor de IA marcará la factura para revisión.</p>
          <Field label="Justificación (mín. 10 caracteres)"><textarea rows={3} value={justify} onChange={(e) => setJustify(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}
