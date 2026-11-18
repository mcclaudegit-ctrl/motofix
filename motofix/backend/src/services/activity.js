// Actividad del equipo (para Gerencia): qué hizo cada colaborador en un día, a partir de la bitácora.
// Solo lee audit_log; no agrega ni modifica nada. Los días y horas son de Costa Rica.
import { all, get } from '../db.js';
import { config } from '../config.js';
import { localParts } from '../lib/time.js';
import { ROLES } from '../permissions.js';

// Categorías que ve el gerente. El orden es el de las columnas y del detalle.
export const CATEGORIES = [
  { key: 'ingresos', label: 'Ingresos al sistema' },
  { key: 'facturas', label: 'Facturas de venta' },
  { key: 'cxp', label: 'Facturas por pagar ingresadas' },
  { key: 'aprobaciones', label: 'Aprobaciones' },
  { key: 'rechazos', label: 'Rechazos' },
  { key: 'ordenes', label: 'Órdenes de trabajo' },
  { key: 'compras', label: 'Compras e insumos' },
  { key: 'clientes', label: 'Clientes, cotizaciones e inventario' },
  { key: 'revision', label: 'Revisiones y reportes' },
  { key: 'seguridad', label: 'Bloqueos de seguridad' },
  { key: 'configuracion', label: 'Configuración y accesos' },
  { key: 'navegacion', label: 'Pantallas visitadas' },
  { key: 'otros', label: 'Otros' },
];

export function categoryOf(e) {
  const a = e.action; const en = e.entity || ''; const d = String(e.detail || '').toLowerCase();
  if (a === 'LOGIN' || a === 'LOGOUT') return 'ingresos';
  if (a === 'NAVEGACION' || a === 'CLICK') return 'navegacion';
  if (a === 'ACCESO_DENEGADO' || a === 'DUPLICADO_BLOQUEADO' || a === 'SEGREGACION_BLOQUEADA') return 'seguridad';
  if (a === 'CXP_APROBACION') return 'aprobaciones';
  if (a === 'APROBACION') return /rechaz/.test(d) ? 'rechazos' : 'aprobaciones';
  if (a === 'ESCANEO_IA' || a === 'EXPORTACION' || a === 'CXP_REVISION' || a === 'CXP_REPORTE_DESCARGA' || en === 'anomalia' || en === 'anomalias' || en === 'reporte_cxp' || en === 'auditoria') return 'revision';
  if (a === 'CXP_RECHAZO') return 'rechazos';
  if (a === 'CXP_RECIBIDA' || a === 'CXP_BANDEJA' || a === 'CXP_IMPORTACION' || a === 'CXP_IMPORTACION_CARGA') return 'cxp';
  if (a.startsWith('CONFIG') || en === 'permisos' || en === 'usuario' || en === 'configuracion' || en === 'pesos_riesgo' || a === 'CAMBIO_CUENTA_PROVEEDOR' || a === 'CXP_PROVEEDOR_ALTA') return 'configuracion';
  if (en === 'factura') return 'facturas';
  if (en === 'factura_proveedor') return /aprob|pagad/.test(d) ? 'aprobaciones' : /rechaz/.test(d) ? 'rechazos' : 'compras';
  if (en === 'solicitud') return 'facturas';
  if (en === 'orden_trabajo') return 'ordenes';
  if (['cliente', 'cotizacion', 'precuenta', 'inventario', 'producto'].includes(en)) return 'clientes';
  if (a.startsWith('CXP')) return 'cxp';
  return 'otros';
}

// Límites UTC de un día local (Costa Rica, sin horario de verano).
function dayRange(date) {
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - config.tzOffsetHours * 3600e3);
  return [start.toISOString(), new Date(start.getTime() + 86400e3).toISOString()];
}
export const todayLocal = () => localParts(new Date().toISOString()).date;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// Tiempo activo aproximado: eventos separados por más de 30 min se cuentan como sesiones distintas;
// cada sesión dura desde su primer hasta su último evento (mínimo 1 minuto).
const GAP_MS = 30 * 60e3;
function activeMinutes(times) {
  if (!times.length) return 0;
  let total = 0; let s = times[0]; let prev = times[0];
  for (const t of times.slice(1)) {
    if (t - prev > GAP_MS) { total += Math.max(60e3, prev - s); s = t; }
    prev = t;
  }
  total += Math.max(60e3, prev - s);
  return Math.round(total / 60e3);
}

function summarize(events) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  for (const e of events) counts[categoryOf(e)]++;
  const times = events.map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
  const logins = events.filter((e) => e.action === 'LOGIN').map((e) => e.ts).sort();
  return {
    counts,
    total: events.length,
    actions: events.length - counts.navegacion,
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    first_login: logins[0] || null,
    logins: logins.length,
    active_minutes: activeMinutes(times),
  };
}

const USERS_SQL = "SELECT id, name, email, role, active FROM users WHERE role != 'proveedor' OR id IN (SELECT DISTINCT user_id FROM audit_log WHERE ts >= ? AND ts < ?) ORDER BY id";

/** Resumen del día: una fila por colaborador (también los que no tuvieron actividad). */
export function teamDay(date = todayLocal()) {
  if (!isDate(date)) date = todayLocal();
  const [from, to] = dayRange(date);
  const events = all('SELECT user_id, ts, action, entity, detail FROM audit_log WHERE ts >= ? AND ts < ? AND user_id IS NOT NULL', from, to);
  const byUser = new Map();
  for (const e of events) { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); }
  const users = all(USERS_SQL, from, to).map((u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role]?.label || u.role, active: u.active,
    ...summarize(byUser.get(u.id) || []),
  }));
  users.sort((a, b) => b.actions - a.actions || b.total - a.total || a.id - b.id);
  const team = summarize(events);
  return { date, today: todayLocal(), categories: CATEGORIES, users, team: { ...team, people: users.filter((u) => u.total > 0).length } };
}

/** Detalle de un colaborador en un día: eventos con hora, actividad por hora y últimos 14 días. */
export function userDay(userId, date = todayLocal()) {
  if (!isDate(date)) date = todayLocal();
  const u = get('SELECT id, name, email, role, active FROM users WHERE id = ?', userId);
  if (!u) return null;
  const [from, to] = dayRange(date);
  const events = all('SELECT id, ts, action, entity, entity_id, detail, ip, device FROM audit_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts, id', userId, from, to)
    .map((e) => ({ ...e, category: categoryOf(e), time: localParts(e.ts).hm }));
  const hours = Array.from({ length: 24 }, () => ({ actions: 0, navegacion: 0 }));
  for (const e of events) hours[localParts(e.ts).hour][e.category === 'navegacion' ? 'navegacion' : 'actions']++;

  // Últimos 14 días que terminan en la fecha elegida
  const [from14] = dayRange(new Date(Date.parse(`${date}T00:00:00Z`) - 13 * 86400e3).toISOString().slice(0, 10));
  const recent = all('SELECT ts, action FROM audit_log WHERE user_id = ? AND ts >= ? AND ts < ?', userId, from14, to);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.parse(`${date}T00:00:00Z`) - i * 86400e3).toISOString().slice(0, 10);
    days.push({ date: d, actions: 0, logins: 0 });
  }
  const idx = Object.fromEntries(days.map((d, i) => [d.date, i]));
  for (const e of recent) {
    const d = days[idx[localParts(e.ts).date]]; if (!d) continue;
    if (e.action === 'LOGIN') d.logins++;
    if (e.action !== 'NAVEGACION' && e.action !== 'CLICK') d.actions++;
  }
  return {
    date, today: todayLocal(), categories: CATEGORIES,
    user: { id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role]?.label || u.role, active: u.active },
    summary: summarize(events), events, hours, days,
  };
}
