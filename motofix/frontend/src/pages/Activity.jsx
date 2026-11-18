import { useEffect, useState } from 'react';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { get } from '../lib/api.js';
import { Button, Card, Badge, Empty, Spinner, Kpi, useLoad, fmtDate } from '../ui.jsx';

// Actividad del equipo (Gerencia): qué hizo cada colaborador en el día, con horas, a partir de la bitácora.
const TONE = { ingresos: 'dark', facturas: 'brand', cxp: 'brand', aprobaciones: 'ok', rechazos: 'danger', seguridad: 'danger', ordenes: '', compras: '', clientes: '', revision: '', configuracion: 'warn', navegacion: '', otros: '' };
const hm = (iso) => (iso ? new Intl.DateTimeFormat('es-CR', { timeZone: 'America/Costa_Rica', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '—');
const dur = (m) => (!m ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);
const shift = (date, d) => new Date(Date.parse(`${date}T12:00:00Z`) + d * 86400e3).toISOString().slice(0, 10);
const longDate = (date) => new Intl.DateTimeFormat('es-CR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
const OTHER = ['compras', 'clientes', 'revision', 'seguridad', 'configuracion', 'otros'];

export default function Activity() {
  const [date, setDate] = useState('');
  const [sel, setSel] = useState(null);
  const team = useLoad(() => get(`/api/activity${date ? `?date=${date}` : ''}`), [date], { poll: 30000 });
  const d = team.data;
  const day = d?.date;
  useEffect(() => { if (d && (!sel || !d.users.some((u) => u.id === sel))) setSel(d.users.find((u) => u.actions > 0)?.id ?? d.users[0]?.id ?? null); }, [d]); // eslint-disable-line

  if (team.loading && !d) return <Spinner />;
  if (team.error && !d) return <Empty>{team.error.message}</Empty>;
  const t = d.team; const c = t.counts;

  return (
    <>
      <div className="page-head">
        <div><h1>Actividad del equipo</h1><p>Qué hizo cada colaborador en el día: ingresos al sistema, facturas ingresadas, aprobaciones y demás registros, con su hora. Se toma de la bitácora de auditoría.</p></div>
        <div className="actions">
          <Button variant="ghost" icon={LuChevronLeft} onClick={() => setDate(shift(day, -1))} aria-label="Día anterior" />
          <input type="date" value={day} max={d.today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Día" />
          <Button variant="ghost" icon={LuChevronRight} onClick={() => setDate(shift(day, 1))} disabled={day >= d.today} aria-label="Día siguiente" />
          {day !== d.today && <Button onClick={() => setDate('')}>Hoy</Button>}
        </div>
      </div>
      <p className="muted" style={{ marginTop: -14, marginBottom: 20 }}>{longDate(day)}{day === d.today ? ' · hoy, se actualiza solo' : ''}</p>

      <div className="grid g4" style={{ marginBottom: 20 }}>
        <Kpi label="Colaboradores con actividad" value={`${t.people} de ${d.users.length}`} sub={t.first ? `Desde las ${hm(t.first)} hasta las ${hm(t.last)}` : 'Nadie ingresó este día'} />
        <Kpi label="Ingresos al sistema" value={c.ingresos} sub="Inicios de sesión" />
        <Kpi label="Facturas ingresadas" value={c.facturas + c.cxp} sub={`${c.facturas} de venta · ${c.cxp} por pagar`} />
        <Kpi label="Aprobaciones" value={c.aprobaciones} sub={`${c.rechazos} rechazos · ${c.seguridad} bloqueos de seguridad`} />
      </div>

      <Card title="Resumen por colaborador" flush>
        <div className="table-wrap"><table className="act-table">
          <thead><tr><th>Colaborador</th><th>Horario</th><th>Tiempo activo</th><th className="right">Ingresos</th><th className="right">Facturas de venta</th><th className="right">Facturas por pagar</th><th className="right">Aprobaciones</th><th className="right">Órdenes</th><th className="right">Otras</th></tr></thead>
          <tbody>{d.users.map((u) => {
            const none = u.total === 0;
            return (
              <tr key={u.id} className={`clickable ${sel === u.id ? 'selected' : ''}`} onClick={() => setSel(u.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(u.id)} aria-selected={sel === u.id}>
                <td className="nowrap"><b>{u.name.split(' (')[0]}</b><br /><small className="muted">{u.roleLabel}</small></td>
                {none ? <td colSpan={8} className="muted">Sin actividad este día</td> : <>
                  <td className="num nowrap">{hm(u.first_login || u.first)} – {hm(u.last)}{!u.first_login && <><br /><small className="muted">venía de una sesión previa</small></>}</td>
                  <td className="num nowrap">{dur(u.active_minutes)}</td>
                  <td className="num right">{u.counts.ingresos}</td>
                  <td className="num right">{u.counts.facturas || <span className="muted">0</span>}</td>
                  <td className="num right">{u.counts.cxp || <span className="muted">0</span>}</td>
                  <td className="num right nowrap">{u.counts.aprobaciones || <span className="muted">0</span>}{u.counts.rechazos > 0 && <small className="muted"> · {u.counts.rechazos} rech.</small>}</td>
                  <td className="num right">{u.counts.ordenes || <span className="muted">0</span>}</td>
                  <td className="num right">{OTHER.reduce((s, k) => s + u.counts[k], 0) || <span className="muted">0</span>}</td>
                </>}
              </tr>);
          })}</tbody>
        </table></div>
      </Card>

      {sel && <UserDetail key={`${sel}-${day}`} id={sel} date={day} onPickDay={setDate} />}
    </>
  );
}

function UserDetail({ id, date, onPickDay }) {
  const [nav, setNav] = useState(false);
  const { data, loading } = useLoad(() => get(`/api/activity/${id}?date=${date}`), [id, date], { poll: 30000 });
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const { user, summary: s, events, hours, days, categories } = data;
  const label = Object.fromEntries(categories.map((c) => [c.key, c.label]));
  const shown = nav ? events : events.filter((e) => e.category !== 'navegacion');
  const maxH = Math.max(1, ...hours.map((h) => h.actions + h.navegacion));
  const maxD = Math.max(1, ...days.map((x) => x.actions));
  const used = categories.filter((c) => s.counts[c.key] > 0);

  return (
    <div className="grid g-main" style={{ marginTop: 20, alignItems: 'start' }}>
      <Card title={`${user.name.split(' (')[0]} · ${user.roleLabel}`} flush
        actions={<label className="chk" style={{ fontSize: 13.5 }}><input type="checkbox" checked={nav} onChange={(e) => setNav(e.target.checked)} />Mostrar pantallas visitadas</label>}>
        <div className="card-b" style={{ paddingTop: 6 }}>
          {s.total === 0 ? <p className="muted" style={{ margin: 0 }}>Sin actividad este día.</p> : (
            <p style={{ margin: 0, color: 'var(--ink-2)' }}>
              {s.first_login ? <>Ingresó a las <b>{hm(s.first_login)}</b></> : <>Siguió con una sesión abierta desde antes; primera acción a las <b>{hm(s.first)}</b></>}
              {' '}y su última actividad fue a las <b>{hm(s.last)}</b>. Tiempo activo aproximado: <b>{dur(s.active_minutes)}</b>.
            </p>)}
          {used.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12 }}>
            {used.map((c) => <Badge key={c.key} tone={TONE[c.key]}>{c.label}: {s.counts[c.key]}</Badge>)}
          </div>}
        </div>
        {shown.length === 0 ? <Empty>{events.length ? 'Solo visitó pantallas. Activa «Mostrar pantallas visitadas» para verlas.' : 'Nada que mostrar.'}</Empty> : (
          <ol className="timeline">
            {shown.map((e) => (
              <li key={e.id} className={e.category === 'navegacion' ? 'nav' : ''}>
                <time className="num">{e.time}</time>
                <div><Badge tone={TONE[e.category]}>{label[e.category]}</Badge><p>{e.detail || e.action}</p>{e.device && <small className="muted">{e.device}{e.ip ? ` · ${e.ip}` : ''}</small>}</div>
              </li>))}
          </ol>)}
      </Card>

      <div className="grid">
        <Card title="Actividad por hora">
          <div className="hours" role="img" aria-label="Acciones por hora del día">
            {hours.map((h, i) => (
              <div key={i} className="h" title={`${String(i).padStart(2, '0')}:00 · ${h.actions} acciones${h.navegacion ? ` · ${h.navegacion} pantallas` : ''}`}>
                <div className="stack" style={{ height: `${((h.actions + h.navegacion) / maxH) * 100}%` }}>
                  <i className="nav" style={{ flex: h.navegacion }} /><i style={{ flex: h.actions }} />
                </div>
                {i % 3 === 0 && <span>{String(i).padStart(2, '0')}</span>}
              </div>))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>Barra oscura: acciones registradas. Gris claro: pantallas visitadas.</p>
        </Card>
        <Card title="Últimos 14 días">
          <div className="days">
            {days.map((x) => (
              <button key={x.date} className={`d ${x.date === date ? 'on' : ''}`} onClick={() => onPickDay(x.date)} title={`${fmtDate(x.date + 'T12:00:00Z')}: ${x.actions} acciones · ${x.logins} ingresos`}>
                <div className="bar"><i style={{ height: `${(x.actions / maxD) * 100}%` }} /></div>
                <span>{x.date.slice(8)}</span>
              </button>))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>Acciones por día. Toca un día para verlo.</p>
        </Card>
      </div>
    </div>
  );
}
