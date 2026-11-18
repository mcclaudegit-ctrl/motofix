# MotoFix · Estado y pendientes

## Hecho
- En línea en Vercel (https://motofix-vercel.vercel.app) con base en Turso. Cada commit en `main` se publica solo.
- Aviso de actualización: quien tenga la app abierta ve «Hay una nueva versión de MotoFix» y la página se recarga a los 20 s (o al pulsar «Actualizar ahora»; se puede posponer 5 minutos).
- Vista en teléfono revisada en todas las pantallas (375 px): barra superior en una fila, notificaciones a todo el ancho y formularios apilados.
- Reportes Excel en formato .xlsx real (sin advertencia de formato).
- Tarea programada diaria activa sin necesidad de CRON_SECRET.
- Lectura de PDF con Gemini usando el alias `gemini-flash-latest` y mensajes de error claros.
- 38 pruebas (`cd backend && npm test`).

## Pendiente
1. **Gemini con clave real:** configurar `AI_PROVIDER=gemini` y `AI_API_KEY` en Vercel y probar con un PDF real. Sin clave, la lectura funciona en modo simulado.
2. **Importación:** solo SQLite y CSV, hasta 4 MB en Vercel (límite de la plataforma). PostgreSQL y MySQL requieren exportación previa.

## Cómo correr en local
- Backend: `cd backend && npm start` (Node 22.13+), abre http://localhost:4000.
- Pruebas: `cd backend && npm test`.
- Frontend: `cd frontend && npm install && node build.mjs`.
