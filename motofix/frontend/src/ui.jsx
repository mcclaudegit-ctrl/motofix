import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { LuLock, LuX, LuTriangleAlert, LuCircleAlert, LuInfo } from 'react-icons/lu';
import { track } from './lib/api.js';

export const crc = (n) => '₡' + new Intl.NumberFormat('es-CR').format(Math.round(n || 0));
export const fmtDate = (iso, withTime = false) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const o = { timeZone: 'America/Costa_Rica', day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(o, { hour: '2-digit', minute: '2-digit', hour12: false });
  return new Intl.DateTimeFormat('es-CR', o).format(d).replace(',', '');
};
export const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`; if (m < 1440) return `hace ${Math.round(m / 60)} h`; return `hace ${Math.round(m / 1440)} d`; };

export function Button({ locked, variant, size, icon: Icon, children, className = '', trackAs, onClick, ...p }) {
  return (
    <button {...p} className={`btn ${variant || ''} ${size || ''} ${locked ? 'locked' : ''} ${className}`}
      title={locked ? 'Tu rol no tiene permiso para esta acción (se registrará el intento)' : p.title}
      onClick={(e) => { if (trackAs) track('CLICK', trackAs[0], trackAs[1]); onClick?.(e); }}>
      {locked ? <LuLock /> : Icon && <Icon />}{children}
    </button>
  );
}

export const Card = ({ title, icon: Icon, actions, children, className = '', flush }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-h"><h3>{Icon && <Icon size={17} />}{title}</h3><div className="actions">{actions}</div></header>}
    {flush ? children : <div className="card-b">{children}</div>}
  </section>
);

export const Badge = ({ tone = '', icon: Icon, children }) => <span className={`badge b-${tone}`}>{Icon && <Icon />}{children}</span>;

const STATUS = {
  pendiente: ['warn', 'Pendiente'], pagada: ['ok', 'Pagada'], anulada: ['danger', 'Anulada'], aprobada: ['ok', 'Aprobada'], rechazada: ['danger', 'Rechazada'],
  abierta: ['brand', 'Abierta'], en_proceso: ['warn', 'En proceso'], completada: ['ok', 'Completada'], facturada: ['dark', 'Facturada'], cancelada: ['danger', 'Cancelada'],
  borrador: ['', 'Borrador'], enviada: ['brand', 'Enviada'], revisada: ['ok', 'Revisada'], descartada: ['', 'Descartada'],
};
export const StatusBadge = ({ status, label }) => { const [t, l] = STATUS[status] || ['', status]; return <Badge tone={t}>{label || l}</Badge>; };
export const SevBadge = ({ sev }) => <Badge tone={{ alta: 'danger', media: 'warn', baja: 'brand' }[sev]}>{sev === 'alta' ? 'Alta' : sev === 'media' ? 'Media' : 'Baja'}</Badge>;

export const Kpi = ({ label, icon: Icon, value, sub, alert }) => (
  <div className={`card kpi ${alert ? 'alert' : ''}`}>
    <div className="label">{Icon && <Icon size={15} />}{label}</div>
    <div className="value num">{value}</div>
    <div className="sub">{sub}</div>
  </div>
);

// Marca de MotoFix: engranaje, aro y check de auditoría. Con `animated` se dibuja una vez al montar (ver .mark.play en styles.css).
const GEAR = (() => {
  const teeth = 10, ro = 56, ri = 46, pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2, s = Math.PI / teeth;
    const at = (t, r) => [Math.cos(a + t) * r, Math.sin(a + t) * r].map((n) => n.toFixed(2)).join(' ');
    pts.push(at(-s * 0.95, ri), at(-s * 0.55, ro), at(s * 0.55, ro), at(s * 0.95, ri));
  }
  return 'M' + pts.join(' L') + ' Z';
})();
export const LogoMark = ({ animated, className = '' }) => (
  <svg className={`mark ${animated ? 'play' : ''} ${className}`} viewBox="-66 -66 132 132" aria-hidden="true">
    <path className="m-gear" d={GEAR} pathLength="1" />
    <circle className="m-hole" r="30" />
    <circle className="m-ring" r="27" pathLength="1" />
    <path className="m-check" d="M-14 0 L-3 12 L34 -30" pathLength="1" />
  </svg>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;
export const Spinner = () => <div className="spin" role="status" aria-label="Cargando" />;

export function Field({ label, hint, children }) {
  return <div className="field"><label>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose?.(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h"><h3>{title}</h3><button className="btn ghost sm" onClick={onClose} aria-label="Cerrar"><LuX /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

/** Pop-up de seguridad (PRD 1.1.4): permiso denegado, bitácora inmutable o duplicado bloqueado. */
export function SecurityModal({ event, onClose, extra }) {
  const dup = event.error === 'FACTURA_DUPLICADA';
  const Icon = dup ? LuCircleAlert : LuLock;
  const title = dup ? 'Factura duplicada bloqueada' : event.error === 'BITACORA_INMUTABLE' ? 'Bitácora protegida' : 'Acción bloqueada';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title} style={{ width: 'min(480px,100%)' }}>
        <div className={`secure ${dup ? 'warn' : ''}`}>
          <div className="shield"><Icon /></div>
          <h3>{title}</h3>
          <p>{event.message}</p>
          {!dup && (
            <dl className="facts">
              <dt>Rol actual</dt><dd>{event.roleLabel || event.role || '—'}</dd>
              <dt>Acción</dt><dd>{event.action || '—'}</dd>
              {event.permission && <><dt>Permiso requerido</dt><dd className="mono">{event.permission}</dd></>}
            </dl>
          )}
          <div className={`callout ${dup ? 'warn' : 'danger'}`} style={{ textAlign: 'left', marginTop: 12 }}>
            <LuTriangleAlert size={16} />
            <span>{dup ? 'El intento quedó registrado y el motor de IA generó una alerta.' : 'El intento fue registrado en la bitácora de auditoría y notificado a Administración, Gerencia y Contabilidad.'}</span>
          </div>
        </div>
        <div className="modal-f" style={{ justifyContent: 'center' }}>{extra}<Button variant="dark" onClick={onClose} autoFocus>Entendido</Button></div>
      </div>
    </div>
  );
}

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [list, setList] = useState([]);
  const id = useRef(0);
  const push = useCallback((msg, kind = '') => {
    const k = ++id.current; setList((l) => [...l, { k, msg, kind }]);
    setTimeout(() => setList((l) => l.filter((x) => x.k !== k)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{list.map((t) => <div key={t.k} className={`toast ${t.kind}`}><LuInfo size={16} />{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/** Carga datos con recarga manual y (opcional) sondeo periódico. */
export function useLoad(fn, deps = [], { poll } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn); fnRef.current = fn;
  const load = useCallback(async (silent) => {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try { setState({ data: await fnRef.current(), error: null, loading: false }); }
    catch (e) { setState((s) => ({ data: s.data, error: e, loading: false })); }
  }, []);
  useEffect(() => { load(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!poll) return; const t = setInterval(() => load(true), poll); return () => clearInterval(t); }, [poll, load]);
  return { ...state, reload: () => load(true) };
}

export const useDebounced = (value, ms = 300) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
};
