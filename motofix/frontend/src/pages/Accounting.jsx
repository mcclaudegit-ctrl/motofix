import { useState } from 'react';
import { LuDownload, LuCircleCheck, LuTriangleAlert, LuScale } from 'react-icons/lu';
import { get, download, track } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Button, Card, Badge, Empty, Spinner, useLoad, useToast, crc, fmtDate, Kpi } from '../ui.jsx';

const STATE = { reconocido: ['ok', 'Ingreso reconocido'], diferido: ['brand', 'Ingreso diferido'], por_facturar: ['warn', 'Por facturar'], prematuro: ['danger', 'Reconocido antes de tiempo'] };

export default function Accounting() {
  const { can } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState('resumen');
  const sum = useLoad(() => get('/api/accounting/summary'), []);
  const n15 = useLoad(() => get('/api/accounting/niif15'), [], { poll: 20000 });
  const [onlyEx, setOnlyEx] = useState(false);
  const exp = async (type) => { try { await download(`/api/accounting/ledger?type=${type}`, `libro_${type}.csv`); toast('Libro exportado', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  const s = sum.data;
  return (
    <>
      <div className="page-head"><div><h1>Contabilidad y NIIF 15</h1><p>Conciliaciones, cruce orden de trabajo vs. factura y exportación de libros contables.</p></div></div>
      <div className="tabs">{[['resumen', 'Resumen y conciliación'], ['niif', 'Monitor NIIF 15'], ['libros', 'Libros contables']].map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); track('CLICK', 'pestaña', `Contabilidad: ${l}`); }}>{l}</button>)}</div>

      {tab === 'resumen' && (!s ? <Spinner /> : <>
        <div className="grid g4" style={{ marginBottom: 16 }}>
          <Kpi label="Ventas (con IVA)" icon={LuScale} value={crc(s.ventas.total)} sub={`${s.ventas.n} facturas · base ${crc(s.ventas.base)}`} />
          <Kpi label="Cobrado" value={crc(s.ventas.cobrado.t)} sub={`${s.ventas.cobrado.n} facturas pagadas`} />
          <Kpi label="Por cobrar" value={crc(s.ventas.por_cobrar.t)} sub={`${s.ventas.por_cobrar.n} facturas pendientes`} />
          <Kpi label="Por pagar a proveedores" value={crc(s.compras.por_pagar.t)} sub={`${s.compras.por_pagar.n} facturas aprobadas`} />
        </div>
        <div className="grid g3">
          <Card title="IVA (13%)"><dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}><dt>IVA débito (ventas)</dt><dd className="num">{crc(s.iva.debito)}</dd><dt>IVA crédito (compras)</dt><dd className="num">{crc(s.iva.credito)}</dd><dt><b>IVA neto a pagar</b></dt><dd className="num"><b>{crc(s.iva.neto)}</b></dd></dl></Card>
          <Card title="Conciliación de ventas">
            <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}><dt>Ventas registradas</dt><dd className="num">{crc(s.conciliacion.ventas_total)}</dd><dt>Cobrado + por cobrar</dt><dd className="num">{crc(s.conciliacion.cobrado_mas_por_cobrar)}</dd><dt><b>Diferencia</b></dt><dd className="num"><b>{crc(s.conciliacion.diferencia)}</b></dd></dl>
            {s.conciliacion.diferencia === 0 ? <Badge tone="ok" icon={LuCircleCheck}>Conciliado</Badge> : <Badge tone="danger" icon={LuTriangleAlert}>Descuadre</Badge>}
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Anuladas (excluidas): {s.ventas.anulado.n} · {crc(s.ventas.anulado.t)}</p></Card>
          <Card title="Valor del inventario"><dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}><dt>A costo</dt><dd className="num">{crc(s.inventario.cost_value)}</dd><dt>A precio de venta</dt><dd className="num">{crc(s.inventario.sale_value)}</dd></dl><p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Compras aprobadas: {crc(s.compras.total)} · pagadas: {crc(s.compras.pagado)}</p></Card>
        </div></>)}

      {tab === 'niif' && (!n15.data ? <Spinner /> : <>
        <div className="callout" style={{ marginBottom: 14 }}><LuScale size={16} /><span><b>Cruce NIIF 15.</b> Contrato = orden de trabajo; obligación de desempeño = servicio y repuestos entregados; el ingreso se reconoce al completar la orden. Se verifica que cada factura cuadre con su orden, que no se facture antes de cumplir y que los descuentos tengan aprobación.</span></div>
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <Kpi label="Ingreso reconocido" value={crc(n15.data.summary.reconocido)} sub="Órdenes completadas y facturadas" />
          <Kpi label="Ingreso diferido" value={crc(n15.data.summary.diferido)} sub="Órdenes abiertas / en proceso" />
          <Kpi label="Completado sin facturar" value={crc(n15.data.summary.por_facturar)} sub="Obligación cumplida" alert={n15.data.summary.por_facturar > 0} />
          <Kpi label="Excepciones" value={n15.data.summary.excepciones} sub={`${n15.data.summary.conformes} órdenes conformes`} alert={n15.data.summary.excepciones > 0} />
        </div>
        <div className="toolbar"><label className="chk"><input type="checkbox" checked={onlyEx} onChange={(e) => setOnlyEx(e.target.checked)} /> Solo excepciones</label></div>
        <Card flush><div className="table-wrap"><table><thead><tr><th>Orden</th><th>Cliente</th><th>Estado orden</th><th className="right">Valor orden</th><th>Factura</th><th className="right">Facturado</th><th>Tratamiento</th><th>Verificaciones</th></tr></thead>
          <tbody>{n15.data.rows.filter((r) => !onlyEx || (!r.compliant && r.state !== 'diferido')).map((r) => (
            <tr key={r.work_order_id} className={!r.compliant ? 'flag' : ''}><td className="mono"><b>{r.number}</b></td><td>{r.customer}<br /><small className="muted">{r.motorcycle}</small></td><td>{r.wo_status}{r.completed_at && <><br /><small className="muted">{fmtDate(r.completed_at, true)}</small></>}</td>
              <td className="right num">{crc(r.expected)}</td><td>{r.invoice_id ? <Link className="mono" to={`/facturas/${r.invoice_id}`}>{r.invoice_number}</Link> : <span className="muted">—</span>}</td><td className="right num">{r.invoiced != null ? crc(r.invoiced) : '—'}</td>
              <td><Badge tone={STATE[r.state][0]}>{STATE[r.state][1]}</Badge></td>
              <td style={{ fontSize: 12.5, minWidth: 260 }}>{r.checks.map((c, i) => <div key={i} style={{ color: c.ok ? 'var(--ok)' : 'var(--danger)' }}>{c.ok ? '✓' : '✗'} {c.text}</div>)}</td></tr>))}</tbody></table></div></Card></>)}

      {tab === 'libros' && (
        <div className="grid g2">
          <Card title="Libro de ventas" icon={LuDownload}><p className="muted">Todas las facturas emitidas con subtotal, descuento, IVA, estado y emisor. CSV compatible con Excel.</p><Button variant="primary" icon={LuDownload} locked={!can('accounting.export')} onClick={() => exp('ventas')}>Exportar libro de ventas</Button></Card>
          <Card title="Libro de compras" icon={LuDownload}><p className="muted">Facturas de proveedores con estado de aprobación, pago y confirmación de entrega.</p><Button variant="primary" icon={LuDownload} locked={!can('accounting.export')} onClick={() => exp('compras')}>Exportar libro de compras</Button></Card>
          <p className="muted" style={{ gridColumn: '1/-1', fontSize: 13 }}>Cada exportación queda registrada en la bitácora de auditoría.</p>
        </div>)}
    </>
  );
}
