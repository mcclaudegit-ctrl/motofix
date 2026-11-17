import { config } from './config.js';
import { all, get, run } from './db.js';
import { verifyToken } from './lib/jwt.js';
import { HttpError } from './lib/http.js';
import { PERMISSIONS, ROLES } from './permissions.js';
import { logEvent } from './audit.js';

export const permissionsOf = (role) => all('SELECT permission FROM role_permissions WHERE role = ?', role).map((r) => r.permission);

export function notify({ audience = 'security', userId = null, level = 'info', title, body = null, link = null, ts = null }) {
  run('INSERT INTO notifications (audience,user_id,level,title,body,link,read,created_at) VALUES (?,?,?,?,?,?,0,?)',
    audience, userId, level, title, body, link, ts || new Date().toISOString());
}

/** Middleware: exige sesión válida y carga usuario + permisos vigentes (se leen de la BD en cada request). */
export async function auth(ctx) {
  const h = ctx.req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyToken(token, config.jwtSecret);
  if (!payload) throw new HttpError(401, 'NO_AUTENTICADO', 'Sesión inválida o expirada. Inicia sesión nuevamente.');
  const u = get('SELECT id,name,email,role,supplier_id,active FROM users WHERE id = ?', payload.sub);
  if (!u || !u.active) throw new HttpError(401, 'NO_AUTENTICADO', 'Usuario inactivo o inexistente.');
  ctx.user = { ...u, permissions: new Set(permissionsOf(u.role)) };
}

/**
 * Middleware de autorización (any-of). Si el rol no tiene el permiso:
 *   1) registra ACCESO_DENEGADO en la bitácora inmutable,
 *   2) notifica a los roles de seguridad,
 *   3) responde 403 con datos para el pop-up de seguridad del frontend.
 */
export const perm = (...needed) => async (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'NO_AUTENTICADO', 'Sesión requerida');
  if (needed.some((p) => ctx.user.permissions.has(p))) return;
  denyAccess(ctx, needed[0]);
};

export function denyAccess(ctx, permission, actionLabel) {
  const label = actionLabel || PERMISSIONS[permission]?.label || permission;
  const roleLabel = ROLES[ctx.user.role]?.label || ctx.user.role;
  logEvent({
    user: ctx.user, action: 'ACCESO_DENEGADO', entity: 'permiso', entityId: permission,
    detail: `Intentó: ${label} (${ctx.req.method} ${ctx.req.url.split('?')[0]})`, ip: ctx.ip, device: ctx.device,
  });
  notify({
    level: 'warning', title: `Acción bloqueada a ${ctx.user.name}`,
    body: `${roleLabel} intentó «${label}» sin autorización. IP ${ctx.ip}.`, link: '/auditoria',
  });
  throw new HttpError(403, 'PERMISO_DENEGADO', `Tu rol (${roleLabel}) no tiene autorización para: ${label}.`, {
    permission, role: ctx.user.role, roleLabel, action: label,
  });
}

export const can = (ctx, p) => ctx.user.permissions.has(p);
