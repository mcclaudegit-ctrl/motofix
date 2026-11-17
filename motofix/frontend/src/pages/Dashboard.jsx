import { LuReceipt, LuClock, LuTriangleAlert, LuBrainCircuit, LuTrendingUp, LuTrendingDown, LuWrench, LuFileText, LuPackage, LuActivity, LuScanLine, LuArrowRight } from 'react-icons/lu';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { Card, Kpi, Badge, SevBadge, Spinner, Empty, useLoad, crc, fmtDate, ago, Button } from '../ui.jsx';

export default function Dashboard() {
  const { can, user } = useAuth();
  const { data, loading, error } = useLoad(() => get('/api/dashboard'), [], { poll: 10000 });
  if (loading && !data) return <Spinner />;
  if (error && !data) return <Empty>{error.message}</Empty>;
  return data.level === 'executive' ? <Executive d={data} can={can} /> : <Basic d={data} user={user} />;
}

function Executive({ d, can }) {
  const k = d.kpis; const max = Math.max(...d.daily_sales.map((x) => x.total), 1);
  const maxAct = Math.max(...d.activity_by_role.map((x) => x.n), 1);
  const delta = k.total_facturado.delta_pct;
  const sev = d.anomalies_by_severity;
  return (
    <>
      <div className="page-head">
        <div><h1>Dashboard ejecutivo</h1><p>Visión consolidada del taller, orientada a auditoría: facturación, pendientes y alertas del motor de IA.</p></div>
        <span className="live">Actualización en vivo</span>
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi label="Total facturado (mes)" icon={LuReceipt} value={crc(k.total_facturado.month)}
          sub={<>{delta != null && <span className={delta >= 0 ? 'delta-up' : 'delta-down'}>{delta >= 0 ? <LuTrendingUp style={{ verticalAlign: -2 }} /> : <LuTrendingDown style={{ verticalAlign: -2 }} />} {Math.abs(delta).toFixed(0)}% </span>}vs. mes anterior · {k.total_facturado.count} facturas</>} />
        <Kpi label="Transacciones pendientes" icon={LuClock} value={k.pendientes.total}
          sub={`${k.pendientes.invoices} por cobrar (${crc(k.pendientes.invoices_amount)}) · ${k.pendientes.purchases} compras · ${k.pendientes.approvals} aprobaciones`} />
        <Kpi alert={k.con_alertas.count > 0} label="Facturas con alertas" icon={LuTriangleAlert} value={k.con_alertas.count} sub={`${crc(k.con_alertas.amount)} involucrados`} />
        <Kpi label="Alertas de IA abiertas" icon={LuBrainCircuit} value={sev.alta + sev.media + sev.baja}
          sub={<><Badge tone="danger">{sev.alta} altas</Badge> <Badge tone="warn">{sev.media} medias</Badge> <Badge tone="brand">{sev.baja} bajas</Badge></>} />
      </div>

      <div className="grid g-main" style={{ marginBottom: 16 }}>
        <Card title="Inteligencia artificial · transacciones sospechosas" icon={LuBrainCircuit} flush
          actions={can('ai.view') && <Link to="/ia" className="btn primary sm"><LuScanLine /> Escanear facturas</Link>}>
          {d.top_alerts.length === 0 && <Empty>Sin alertas abiertas. Todo en orden.</Empty>}
          {d.top_alerts.map((a) => (
            <div key={a.id} className={`alert-item sev-${a.severity}`}>
              <div className="ico"><LuTriangleAlert size={18} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4>{a.title}</h4><p>{a.detail}</p>
                <small className="muted">{ago(a.created_at)} · <span className="mono">{a.rule}</span></small>
              </div>
              <div style={{ textAlign: 'right' }}><SevBadge sev={a.severity} /><div style={{ marginTop: 6 }}><span className="score"><i style={{ width: `${a.score}%` }} /></span> <small className="mono">{a.score}</small></div></div>
            </div>
          ))}
          {d.top_alerts.length > 0 && <div style={{ padding: '10px 18px' }}><Link to="/ia">Ver todas las alertas <LuArrowRight style={{ verticalAlign: -2 }} /></Link></div>}
        </Card>
        <Card title="Actividad por rol (7 días)" icon={LuActivity}>
          {d.activity_by_role.map((a) => (
            <div className="hbar" key={a.role}><span>{a.label}</span><div className="track"><div className="fill" style={{ width: `${(a.n / maxAct) * 100}%` }} /></div><b className="num">{a.n}</b></div>
          ))}
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Eventos registrados en la bitácora de auditoría.</p>
        </Card>
      </div>

      <div className="grid g-main">
        <Card title="Ventas facturadas · últimos 30 días" icon={LuReceipt}>
          <div className="bars" role="img" aria-label="Gráfico de ventas diarias">
            {d.daily_sales.map((x) => <div key={x.date} className="bar" style={{ height: `${(x.total / max) * 100}%` }} title={`${fmtDate(x.date + 'T12:00:00Z')}: ${crc(x.total)}`} />)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}><span>{fmtDate(d.daily_sales[0].date + 'T12:00:00Z')}</span><span>Hoy</span></div>
        </Card>
        <div className="grid">
          <Card title="Stock bajo" icon={LuPackage} flush>
            {d.low_stock.length === 0 ? <Empty>Inventario saludable</Empty> : d.low_stock.map((p) => (
              <div key={p.id} className="alert-item" style={{ padding: '9px 18px' }}><div style={{ flex: 1 }}>{p.name}</div><Badge tone="danger">{p.stock} / mín. {p.min_stock}</Badge></div>
            ))}
          </Card>
          {d.recent_activity && (
            <Card title="Últimos eventos de auditoría" icon={LuActivity} flush>
              {d.recent_activity.slice(0, 5).map((e) => (
                <div key={e.id} className="alert-item" style={{ padding: '8px 18px', fontSize: 13 }}><div style={{ flex: 1 }}><b>{e.user_name}</b> <span className="muted">· {e.action}</span><br /><span className="muted">{e.detail}</span></div><small className="muted nowrap">{ago(e.ts)}</small></div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Basic({ d, user }) {
  const wo = Object.fromEntries(d.work_orders.map((x) => [x.status, x.n]));
  return (
    <>
      <div className="page-head"><div><h1>Hola, {user.name.split(' ')[0]}</h1><p>Panel operativo de {user.roleLabel.toLowerCase()}.</p></div></div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Kpi label="Órdenes abiertas" icon={LuWrench} value={(wo.abierta || 0) + (wo.en_proceso || 0)} sub={`${wo.completada || 0} completadas por facturar`} />
        <Kpi label="Mis facturas hoy" icon={LuReceipt} value={d.my_invoices_today.n} sub={crc(d.my_invoices_today.total)} />
        <Kpi label="Cotizaciones abiertas" icon={LuFileText} value={d.open_quotes} sub="Borrador o enviadas" />
        <Kpi label="Productos con stock bajo" icon={LuPackage} value={d.low_stock.length} sub="Consulta el inventario" />
      </div>
      <div className="grid g2">
        <Card title="Stock bajo" icon={LuPackage} flush>{d.low_stock.length === 0 ? <Empty>Sin alertas de stock</Empty> : d.low_stock.map((p) => <div key={p.id} className="alert-item" style={{ padding: '9px 18px' }}><div style={{ flex: 1 }}>{p.name}</div><Badge tone="danger">{p.stock} / mín. {p.min_stock}</Badge></div>)}</Card>
        <Card title="Mi actividad reciente" icon={LuActivity} flush>{d.my_activity.map((e, i) => <div key={i} className="alert-item" style={{ padding: '9px 18px', fontSize: 13 }}><div style={{ flex: 1 }}><b>{e.action}</b> <span className="muted">{e.detail}</span></div><small className="muted nowrap">{ago(e.ts)}</small></div>)}</Card>
      </div>
    </>
  );
}
