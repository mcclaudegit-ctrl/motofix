import { useState } from 'react';
import { LuShieldCheck, LuLock, LuSearch, LuTrash2, LuTriangleAlert } from 'react-icons/lu';
import { get, del } from '../lib/api.js';
import { Button, Card, Badge, Empty, Spinner, useLoad, useToast, useDebounced, fmtDate } from '../ui.jsx';

const ACTIONS = { CREACION: ['ok', 'Creación'], MODIFICACION: ['brand', 'Modificación'], ELIMINACION: ['danger', 'Eliminación'], LOGIN: ['dark', 'Login'], LOGOUT: ['', 'Logout'], ACCESO_DENEGADO: ['danger', 'Acceso denegado'], DUPLICADO_BLOQUEADO: ['warn', 'Duplicado bloqueado'],
  APROBACION: ['ok', 'Aprobación'], ESCANEO_IA: ['brand', 'Escaneo del Auditor Inteligente'], EXPORTACION: ['warn', 'Exportación'], NAVEGACION: ['', 'Navegación'], CLICK: ['', 'Clic'] };
const ROLES = { admin: 'Administrador', gerente: 'Gerente', contador: 'Contador', recepcionista: 'Recepcionista', ventas: 'Ventas', proveedor: 'Proveedor' };

export default function Audit() {
  const toast = useToast();
  const [f, setF] = useState({ action: '', role: '', q: '', from: '', to: '' }); const [limit, setLimit] = useState(100);
  const dq = useDebounced(f.q);
  const qs = `limit=${limit}&action=${f.action}&role=${f.role}&q=${encodeURIComponent(dq)}&from=${f.from}&to=${f.to}`;
  const { data, loading, reload } = useLoad(() => get(`/api/audit?${qs}`), [qs], { poll: 10000 });
  const [verify, setVerify] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const doVerify = async () => { try { setVerify(await get('/api/audit/verify')); reload(); } catch (e) { toast(e.message, 'err'); } };
  const tamper = async () => { const id = data?.events[data.events.length - 1]?.id || 1; try { await del(`/api/audit/${id}`); } catch { reload(); } };

  return (
    <>
      <div className="page-head"><div><h1>Bitácora de auditoría</h1><p>Registro inmutable de eventos con usuario, rol, acción, IP y dispositivo. Cada fila encadena el hash de la anterior (SHA-256) y la base de datos impide modificarla o borrarla.</p></div>
        <div className="actions"><Button icon={LuShieldCheck} onClick={doVerify}>Verificar integridad</Button><Button variant="danger" icon={LuTrash2} onClick={tamper} title="Intenta eliminar un registro para comprobar que está protegido">Probar inmutabilidad</Button></div></div>
      {verify && <div className={`callout ${verify.ok ? 'ok' : 'danger'}`} style={{ marginBottom: 14 }}>{verify.ok ? <LuShieldCheck size={16} /> : <LuTriangleAlert size={16} />}<span>{verify.ok ? <>Cadena íntegra: <b>{verify.count}</b> eventos verificados. Último hash <span className="mono">{verify.lastHash.slice(0, 16)}…</span></> : <>¡Cadena alterada! Primer registro inconsistente: #{verify.brokenAt}</>}</span></div>}
      <div className="toolbar">
        <div className="search"><LuSearch /><input placeholder="Buscar usuario o detalle" value={f.q} onChange={set('q')} aria-label="Buscar" /></div>
        <select value={f.action} onChange={set('action')} aria-label="Acción"><option value="">Todas las acciones</option>{Object.entries(ACTIONS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={f.role} onChange={set('role')} aria-label="Rol"><option value="">Todos los roles</option>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input type="date" value={f.from} onChange={set('from')} aria-label="Desde" /><input type="date" value={f.to} onChange={set('to')} aria-label="Hasta" />
        <span className="live" style={{ marginLeft: 'auto' }}>En vivo</span>
      </div>
      <Card flush>{loading && !data ? <Spinner /> : data.events.length === 0 ? <Empty>Sin eventos.</Empty> : <>
        <div className="table-wrap"><table><thead><tr><th>#</th><th>Fecha y hora</th><th>Usuario</th><th>Rol</th><th>Acción</th><th>Detalle</th><th>IP / dispositivo</th><th>Hash</th></tr></thead>
          <tbody>{data.events.map((e) => { const [t, l] = ACTIONS[e.action] || ['', e.action]; return (
            <tr key={e.id} className={['ACCESO_DENEGADO', 'DUPLICADO_BLOQUEADO'].includes(e.action) ? 'flag' : ''}><td className="mono muted">{e.id}</td><td className="nowrap">{fmtDate(e.ts, true)}</td><td><b>{e.user_name.split(' (')[0]}</b></td><td>{ROLES[e.role] || e.role}</td>
              <td><Badge tone={t}>{l}</Badge></td><td style={{ maxWidth: 380, fontSize: 13 }}><span className="muted">{e.entity}</span> {e.detail}</td><td style={{ fontSize: 12.5 }}><span className="mono">{e.ip || '—'}</span><br /><span className="muted">{e.device}</span></td><td className="mono muted" title="Hash SHA-256 (primeros 12)"><LuLock size={11} /> {e.hash}</td></tr>); })}</tbody></table></div>
        <div style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="muted">Mostrando {data.events.length} de {data.total}</span>{data.events.length < data.total && <Button onClick={() => setLimit(limit + 200)}>Cargar más</Button>}</div></>}</Card>
    </>
  );
}
