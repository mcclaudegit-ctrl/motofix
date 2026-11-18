import { auth, perm } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { teamDay, userDay } from '../services/activity.js';

// Actividad del equipo (Gerencia): resumen diario por colaborador y detalle con horas.
export function activityRoutes(r) {
  r.get('/api/activity', auth, perm('activity.view'), (ctx) => teamDay(ctx.query.date));
  r.get('/api/activity/:userId', auth, perm('activity.view'), (ctx) => {
    const out = userDay(Number(ctx.params.userId), ctx.query.date);
    if (!out) throw new HttpError(404, 'NO_ENCONTRADO', 'Colaborador no encontrado');
    return out;
  });
}
