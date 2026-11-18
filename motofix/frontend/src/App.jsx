import { useEffect, useState, useRef } from 'react';
import {
  LuLayoutDashboard, LuReceipt, LuWrench, LuUsers, LuFileText, LuPackage, LuTruck, LuCheckCheck, LuScale,
  LuScrollText, LuKeyRound, LuStore, LuBell, LuLogOut, LuMenu, LuX, LuLock, LuShieldAlert, LuTriangleAlert, LuInfo,
  LuWallet, LuMail, LuBuilding2, LuShieldCheck, LuDatabase, LuFileDown, LuSlidersHorizontal,
} from 'react-icons/lu';
import { useAuth } from './lib/auth.jsx';
import { useRouter, Link, matchPath } from './lib/router.jsx';
import { get, post, onSecurityEvent, track } from './lib/api.js';
import { Button, SecurityModal, Spinner, useToast, ago, LogoMark } from './ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { InvoiceList, InvoiceDetail, InvoiceNew } from './pages/Invoices.jsx';
import WorkOrders from './pages/WorkOrders.jsx';
import Customers from './pages/Customers.jsx';
import Inventory from './pages/Inventory.jsx';
import Quotes from './pages/Quotes.jsx';
import Purchases from './pages/Purchases.jsx';
import Approvals from './pages/Approvals.jsx';
import Accounting from './pages/Accounting.jsx';
import AiEngine from './pages/AiEngine.jsx';
import Audit from './pages/Audit.jsx';
import Access from './pages/Access.jsx';
import Portal from './pages/Portal.jsx';
import CxpDashboard, { CxpInvoices, CxpNew, CxpDetail, CxpInbox, CxpVendors, CxpImport, CxpReports, CxpSettings } from './pages/Cxp.jsx';

// Tabla de rutas: cada una declara los permisos (any-of) que la habilitan — "guardias de navegación" (PRD 1.2.3).
const ROUTES = [
  { path: '/', title: 'Dashboard', icon: LuLayoutDashboard, perms: ['dashboard.view', 'dashboard.basic'], el: Dashboard, group: 'Principal' },
  { path: '/cxp', title: 'Panel de riesgo', icon: LuWallet, perms: ['ap.view'], el: CxpDashboard, group: 'Cuentas por pagar' },
  { path: '/cxp/facturas', title: 'Facturas por pagar', icon: LuReceipt, perms: ['ap.view'], el: CxpInvoices, group: 'Cuentas por pagar' },
  { path: '/cxp/facturas/nueva', title: 'Registrar factura', perms: ['ap.simulate'], el: CxpNew },
  { path: '/cxp/facturas/:id', title: 'Detalle CxP', perms: ['ap.view'], el: CxpDetail },
  { path: '/cxp/bandeja', title: 'Bandeja de correo', icon: LuMail, perms: ['ap.view'], el: CxpInbox, group: 'Cuentas por pagar' },
  { path: '/cxp/proveedores', title: 'Proveedores y empleados', icon: LuBuilding2, perms: ['ap.vendors.view'], el: CxpVendors, group: 'Cuentas por pagar' },
  { path: '/cxp/importar', title: 'Importar datos', icon: LuDatabase, perms: ['ap.import'], el: CxpImport, group: 'Cuentas por pagar' },
  { path: '/cxp/reportes', title: 'Reportes', icon: LuFileDown, perms: ['ap.reports'], el: CxpReports, group: 'Cuentas por pagar' },
  { path: '/cxp/configuracion', title: 'Configuración CxP', icon: LuSlidersHorizontal, perms: ['ap.view'], el: CxpSettings, group: 'Cuentas por pagar' },
  { path: '/facturas', title: 'Facturas', icon: LuReceipt, perms: ['invoices.view'], el: InvoiceList, group: 'Fuentes de datos (taller)' },
  { path: '/facturas/nueva', title: 'Nueva factura', perms: ['invoices.create'], el: InvoiceNew },
  { path: '/facturas/:id', title: 'Detalle de factura', perms: ['invoices.view'], el: InvoiceDetail },
  { path: '/ordenes', title: 'Órdenes de trabajo', icon: LuWrench, perms: ['workorders.view'], el: WorkOrders, group: 'Fuentes de datos (taller)' },
  { path: '/clientes', title: 'Clientes', icon: LuUsers, perms: ['customers.view'], el: Customers, group: 'Fuentes de datos (taller)' },
  { path: '/cotizaciones', title: 'Cotizaciones', icon: LuFileText, perms: ['quotes.view'], el: Quotes, group: 'Fuentes de datos (taller)' },
  { path: '/inventario', title: 'Inventario', icon: LuPackage, perms: ['inventory.view'], el: Inventory, group: 'Fuentes de datos (taller)' },
  { path: '/compras', title: 'Compras e insumos', icon: LuTruck, perms: ['purchases.view'], el: Purchases, group: 'Finanzas' },
  { path: '/aprobaciones', title: 'Aprobaciones', icon: LuCheckCheck, perms: ['approvals.request', 'approvals.resolve'], el: Approvals, group: 'Finanzas' },
  { path: '/contabilidad', title: 'Contabilidad y NIIF 15', icon: LuScale, perms: ['accounting.view'], el: Accounting, group: 'Finanzas' },
  { path: '/auditor-inteligente', title: 'Auditor Inteligente', icon: LuShieldCheck, perms: ['ai.view'], el: AiEngine, group: 'Control' },
  { path: '/auditoria', title: 'Bitácora de auditoría', icon: LuScrollText, perms: ['audit.view'], el: Audit, group: 'Control' },
  { path: '/accesos', title: 'Control de accesos', icon: LuKeyRound, perms: ['users.manage', 'permissions.manage'], el: Access, group: 'Control' },
  { path: '/portal', title: 'Portal de proveedores', icon: LuStore, perms: ['supplier.portal'], el: Portal, group: 'Proveedores' },
];

const initials = (n) => n.split(' ').filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w)).slice(0, 2).map((w) => w[0]).join('');

export default function App() {
  const { booting, user } = useAuth();
  const [security, setSecurity] = useState(null);
  useEffect(() => onSecurityEvent((e) => setSecurity(e)), []);
  if (booting) return <Spinner />;
  return (
    <>
      {user ? <Shell /> : <Login />}
      {security && <SecurityModal event={security} onClose={() => setSecurity(null)} />}
    </>
  );
}

function Shell() {
  const { user, can, demoMode, demoLogin, logout } = useAuth();
  const { pathname, navigate } = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState([]);

  const current = ROUTES.map((r) => ({ r, params: matchPath(r.path, pathname) })).find((x) => x.params);
  const allowed = current && can(...current.r.perms);
  const home = can('supplier.portal') && !can('dashboard.view', 'dashboard.basic') ? '/portal' : '/';

  useEffect(() => { if (demoMode) get('/api/auth/demo-roles').then((d) => setRoles(d.roles)).catch(() => {}); }, [demoMode]);
  useEffect(() => { setOpen(false); }, [pathname]);
  // Menú móvil: se cierra con Escape y bloquea el desplazamiento de la página mientras está abierto.
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [open]);
  // Cada navegación queda en la bitácora (PRD criterio 4).
  useEffect(() => { if (current) track('NAVEGACION', 'ruta', `${current.r.title} (${pathname})${allowed ? '' : ' — BLOQUEADA por guardia de navegación'}`); }, [pathname, user.id]); // eslint-disable-line
  useEffect(() => { if (pathname === '/' && home !== '/') navigate(home, { replace: true }); }, [pathname, home, navigate]);
  // Enlaces viejos (notificaciones, marcadores) a la ruta anterior del módulo.
  useEffect(() => { if (pathname === '/ia') navigate('/auditor-inteligente', { replace: true }); }, [pathname, navigate]);

  const switchRole = async (key) => {
    try { await demoLogin(key); navigate('/', { replace: true }); toast('Sesión cambiada (modo demo)'); } catch (e) { toast(e.message, 'err'); }
  };

  const groups = [...new Set(ROUTES.filter((r) => r.group).map((r) => r.group))];
  const Page = current?.r.el;
  // Resalta solo la ruta más específica del menú (p. ej. /cxp/facturas/3 → «Facturas por pagar», no «Panel»)
  const activePath = ROUTES.filter((r) => r.group && (pathname === r.path || (r.path !== '/' && pathname.startsWith(r.path + '/'))))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  return (
    <div className="app">
      {open && <div className="nav-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${open ? 'open' : ''}`} id="menu-lateral">
        <div className="brand"><LogoMark /><span className="wordmark">Moto<b>Fix</b></span>
          <button className="btn ghost menu-close" onClick={() => setOpen(false)} aria-label="Cerrar menú"><LuX /></button></div>
        <nav className="nav" aria-label="Navegación principal">
          {groups.map((g) => {
            const items = ROUTES.filter((r) => r.group === g && can(...r.perms));
            if (!items.length) return null;
            return <div key={g}><div className="nav-group">{g}</div>{items.map((r) => (
              <Link key={r.path} to={r.path} className={activePath === r.path ? 'active' : ''} onClick={() => setOpen(false)}>
                <r.icon />{r.title}
              </Link>))}</div>;
          })}
        </nav>
        <div className="side-foot">MotoFix · Taller de motocicletas<br />Interfaz según permisos de tu rol</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Cerrar menú' : 'Abrir menú'} aria-expanded={open} aria-controls="menu-lateral"><LuMenu /></button>
          <div className="grow" />
          {demoMode && roles.length > 0 && (
            <label className="demo-switch" title="Cambia la sesión entre perfiles para ver cómo cambia la interfaz según el rol">
              <span className="tag">Modo demo · ver como</span>
              <select value={roles.find((r) => r.email === user.email)?.key || ''} onChange={(e) => switchRole(e.target.value)} aria-label="Selector de rol">
                {roles.map((r) => <option key={r.key} value={r.key}>{r.key.startsWith('proveedor') ? `Proveedor ${r.key.slice(-1)}` : r.roleLabel}</option>)}
              </select>
            </label>
          )}
          {can('notifications.security') || true ? <Bell /> : null}
          <div className="userchip">
            <span className="avatar">{initials(user.name)}</span>
            <span className="hide-sm"><b style={{ fontSize: 13 }}>{user.name.split(' (')[0]}</b><br /><span className="muted" style={{ fontSize: 12 }}>{user.roleLabel}</span></span>
          </div>
          <Button variant="ghost" icon={LuLogOut} onClick={logout} aria-label="Cerrar sesión"><span className="hide-sm">Salir</span></Button>
        </header>

        <main className="content">
          {!current ? <NotFound /> : !allowed ? <Restricted route={current.r} home={home} /> : <Page params={current.params} key={pathname} />}
        </main>
      </div>
    </div>
  );
}

function Restricted({ route, home }) {
  const { user } = useAuth();
  return (
    <div className="card" style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', padding: 36 }}>
      <div className="secure" style={{ padding: 0 }}><div className="shield"><LuLock /></div>
        <h3>Sección restringida</h3>
        <p>El rol <b>{user.roleLabel}</b> no tiene acceso a «{route.title}». El intento de navegación quedó registrado en la bitácora.</p>
      </div>
      <Link to={home} className="btn dark">Volver al inicio</Link>
    </div>
  );
}
const NotFound = () => <div className="empty">Página no encontrada. <Link to="/">Ir al inicio</Link></div>;

function Bell() {
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const seen = useRef(new Set());
  const toast = useToast();
  const { navigate } = useRouter();
  const ref = useRef(null);

  const load = async (first) => {
    try {
      const d = await get('/api/notifications', { quiet: true });
      setData(d);
      d.notifications.filter((n) => !n.read && n.level === 'critical' && !seen.current.has(n.id)).slice(0, 1).forEach((n) => { if (!first) toast(n.title, 'err'); });
      d.notifications.forEach((n) => seen.current.add(n.id));
    } catch { /* sesión expirada: lo maneja api.js */ }
  };
  useEffect(() => { load(true); const t = setInterval(() => load(false), 10000); return () => clearInterval(t); }, []); // eslint-disable-line
  useEffect(() => { const c = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false); document.addEventListener('mousedown', c); return () => document.removeEventListener('mousedown', c); }, []);

  const toggle = async () => { setOpen((o) => !o); if (!open && data.unread) { await post('/api/notifications/read', {}, { quiet: true }); setTimeout(() => load(true), 1500); } };
  const Icon = (l) => (l === 'critical' ? <LuShieldAlert color="var(--danger)" /> : l === 'warning' ? <LuTriangleAlert color="var(--warn)" /> : <LuInfo color="var(--brand)" />);

  return (
    <div className="bell" ref={ref}>
      <Button variant="ghost" onClick={toggle} aria-label="Notificaciones" style={{ padding: 8 }}><LuBell size={19} /></Button>
      {data.unread > 0 && <span className="dot">{data.unread}</span>}
      {open && (
        <div className="dropdown" role="menu">
          <div className="card-h"><h3>Notificaciones</h3><span className="live">En vivo</span></div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {data.notifications.length === 0 && <div className="empty">Sin notificaciones</div>}
            {data.notifications.map((n) => (
              <div key={n.id} className={`item ${n.read ? '' : 'unread'}`} style={{ cursor: n.link ? 'pointer' : 'default' }} onClick={() => { if (n.link) { navigate(n.link); setOpen(false); } }}>
                {Icon(n.level)}<div><b>{n.title}</b><span className="muted">{n.body}</span><br /><small className="muted">{ago(n.created_at)}</small></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
