import { all, get } from '../db.js';
import { config } from '../config.js';
import { HttpError, rateLimit } from '../lib/http.js';
import { v } from '../lib/validate.js';
import { signToken } from '../lib/jwt.js';
import { verifyPassword } from '../lib/password.js';
import { ROLES } from '../permissions.js';
import { auth, perm, can, permissionsOf } from '../auth.js';
import { logEvent, ctxLog } from '../audit.js';
import { localParts } from '../lib/time.js';
import { run } from '../db.js';

// En Vercel cada instancia arranca por separado: sin identificador de despliegue no se inventa uno
// (daría avisos falsos); la página usa entonces la huella de sus archivos estáticos.
const APP_VERSION = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || (process.env.VERCEL ? null : `local-${Date.now().toString(36)}`);

function publicUser(u) {
  const supplier = u.supplier_id ? get('SELECT name FROM suppliers WHERE id=?', u.supplier_id) : null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role].label, supplier_id: u.supplier_id, supplierName: supplier?.name || null };
}

function startSession(ctx, u, detail) {
  const token = signToken({ sub: u.id, role: u.role }, config.jwtSecret, config.tokenTtlSeconds);
  logEvent({ user: u, action: 'LOGIN', entity: 'sesion', detail, ip: ctx.ip, device: ctx.device });
  return { token, user: publicUser(u), permissions: permissionsOf(u.role), demoMode: config.demoMode };
}

const DUMMY = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

export function sessionRoutes(r) {
  r.get('/api/health', () => ({ ok: true, demoMode: config.demoMode }));

  // Versión publicada: la página la consulta para avisar y recargar cuando se despliega una nueva.
  // En Vercel cambia con cada despliegue; en un servidor propio, con cada reinicio.
  r.get('/api/version', () => ({ version: APP_VERSION }));

  r.post('/api/auth/login', (ctx) => {
    rateLimit(`login:${ctx.ip}`, 10, 60_000);
    const email = v.email(ctx.body.email);
    const password = v.str(ctx.body.password, 'contraseña', { max: 200 });
    const u = get('SELECT * FROM users WHERE email=?', email);
    const ok = verifyPassword(password, u ? u.password_hash : DUMMY) && u && u.active;
    if (!ok) {
      logEvent({ userName: email, role: '—', action: 'LOGIN', entity: 'sesion', detail: 'Intento fallido de inicio de sesión', ip: ctx.ip, device: ctx.device });
      throw new HttpError(401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos');
    }
    return startSession(ctx, u, 'Inicio de sesión');
  });

  // Selector de rol simulado (PRD 1.1.1). Solo disponible con DEMO_MODE=true.
  r.get('/api/auth/demo-roles', () => {
    if (!config.demoMode) return { enabled: false, roles: [] };
    const rows = all("SELECT demo_key key, name, role, email FROM users WHERE demo_key IS NOT NULL AND active=1 ORDER BY id");
    return { enabled: true, password: config.demoPassword, roles: rows.map((x) => ({ ...x, roleLabel: ROLES[x.role].label })) };
  });

  r.post('/api/auth/demo-login', (ctx) => {
    if (!config.demoMode) throw new HttpError(404, 'NO_ENCONTRADO', 'Modo demo deshabilitado');
    rateLimit(`demo:${ctx.ip}`, 60, 60_000);
    const key = v.str(ctx.body.key, 'rol', { max: 40 });
    const u = get('SELECT * FROM users WHERE demo_key=? AND active=1', key);
    if (!u) throw new HttpError(404, 'NO_ENCONTRADO', 'Perfil demo inexistente');
    return startSession(ctx, u, 'Cambio de rol (modo demo)');
  });

  r.get('/api/auth/me', auth, (ctx) => {
    const u = get('SELECT * FROM users WHERE id=?', ctx.user.id);
    return { user: publicUser(u), permissions: [...ctx.user.permissions], demoMode: config.demoMode };
  });

  r.post('/api/auth/logout', auth, (ctx) => { ctxLog(ctx, 'LOGOUT', 'sesion', null, 'Cierre de sesión'); return { ok: true }; });

  // ---------- Notificaciones ----------
  r.get('/api/notifications', auth, (ctx) => {
    const sec = can(ctx, 'notifications.security');
    const rows = all(`SELECT * FROM notifications WHERE (audience='user' AND user_id=?) ${sec ? "OR audience='security'" : ''} ORDER BY id DESC LIMIT 40`, ctx.user.id);
    return { notifications: rows, unread: rows.filter((n) => !n.read).length };
  });
  r.post('/api/notifications/read', auth, (ctx) => {
    const sec = can(ctx, 'notifications.security');
    run(`UPDATE notifications SET read=1 WHERE read=0 AND ((audience='user' AND user_id=?) ${sec ? "OR audience='security'" : ''})`, ctx.user.id);
    return { ok: true };
  });

  // ---------- Dashboard ----------
  r.get('/api/dashboard', auth, perm('dashboard.view', 'dashboard.basic'), (ctx) => {
    const now = new Date();
    const today = localParts(now.toISOString()).date;
    const localMidnight = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - config.tzOffsetHours * 3600e3).toISOString();
    const monthStart = localMidnight(today.slice(0, 8) + '01');
    const prevDate = new Date(Date.parse(today.slice(0, 8) + '01T00:00:00Z')); prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
    const prevStart = localMidnight(prevDate.toISOString().slice(0, 10));
    const lowStock = all("SELECT id,sku,name,stock,min_stock FROM products WHERE active=1 AND type!='servicio' AND stock <= min_stock ORDER BY stock - min_stock LIMIT 6");

    if (!can(ctx, 'dashboard.view')) {
      return {
        level: 'basic',
        work_orders: all("SELECT status, COUNT(*) n FROM work_orders WHERE status IN ('abierta','en_proceso','completada') GROUP BY status"),
        my_invoices_today: get("SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM invoices WHERE created_by=? AND created_at >= ? AND status!='anulada'", ctx.user.id, localMidnight(today)),
        open_quotes: get("SELECT COUNT(*) n FROM quotes WHERE status IN ('borrador','enviada')").n,
        low_stock: lowStock,
        my_activity: all('SELECT ts, action, entity, detail FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT 8', ctx.user.id),
      };
    }

    const sumSince = (from, to) => get("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM invoices WHERE status!='anulada' AND created_at >= ? AND created_at < ?", from, to);
    const cur = sumSince(monthStart, '9999'); const prev = sumSince(prevStart, monthStart);
    const pend = get("SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM invoices WHERE status='pendiente'");
    const pendPurch = get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM supplier_invoices WHERE status IN ('pendiente','aprobada')");
    const pendAppr = get("SELECT COUNT(*) n FROM approval_requests WHERE status='pendiente'").n;
    const flagged = get("SELECT COUNT(DISTINCT a.ref_id) n, COALESCE(SUM(i.total),0) t FROM anomalies a JOIN invoices i ON i.id=a.ref_id WHERE a.ref_type='invoice' AND a.status='abierta' AND i.status!='anulada'");
    const bySev = Object.fromEntries(all("SELECT severity, COUNT(*) n FROM anomalies WHERE status='abierta' GROUP BY severity").map((x) => [x.severity, x.n]));

    const since = new Date(now - 30 * 86400e3).toISOString();
    const daily = new Map();
    for (let d = 29; d >= 0; d--) daily.set(localParts(new Date(now - d * 86400e3).toISOString()).date, 0);
    for (const i of all("SELECT created_at, total FROM invoices WHERE status!='anulada' AND created_at >= ?", since)) {
      const k = localParts(i.created_at).date; if (daily.has(k)) daily.set(k, daily.get(k) + i.total);
    }
    const weekAgo = new Date(now - 7 * 86400e3).toISOString();
    const activity = all("SELECT role, COUNT(*) n, MAX(ts) last_ts FROM audit_log WHERE ts >= ? AND role != '—' GROUP BY role ORDER BY n DESC", weekAgo)
      .map((a) => ({ ...a, label: ROLES[a.role]?.label || a.role }));

    return {
      level: 'executive',
      kpis: {
        total_facturado: { month: cur.t, prev_month: prev.t, count: cur.n, delta_pct: prev.t ? ((cur.t - prev.t) / prev.t) * 100 : null,
          all_time: get("SELECT COALESCE(SUM(total),0) t FROM invoices WHERE status!='anulada'").t },
        pendientes: { invoices: pend.n, invoices_amount: pend.t, purchases: pendPurch.n, purchases_amount: pendPurch.t, approvals: pendAppr, total: pend.n + pendPurch.n + pendAppr },
        con_alertas: { count: flagged.n, amount: flagged.t },
      },
      anomalies_by_severity: { alta: bySev.alta || 0, media: bySev.media || 0, baja: bySev.baja || 0 },
      daily_sales: [...daily].map(([date, total]) => ({ date, total })),
      activity_by_role: activity,
      top_alerts: all("SELECT id,rule,severity,score,ref_type,ref_id,ref_label,title,detail,created_at FROM anomalies WHERE status='abierta' ORDER BY score DESC, id DESC LIMIT 6"),
      low_stock: lowStock,
      recent_activity: can(ctx, 'audit.view') ? all('SELECT id,ts,user_name,role,action,entity,detail FROM audit_log ORDER BY id DESC LIMIT 8') : null,
    };
  });
}
