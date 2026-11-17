# MotoFix · Estado y pendientes

## Hecho
- Despliegue en Vercel + Turso: base en la nube, función serverless en `api/`, `vercel.json`, carga inicial con `/api/setup` y cron diario. Guía en el README («Publicar en Vercel»).
- Motor de IA y monitor NIIF 15 sin consultas repetidas por fila (mismos resultados, verificado).
- 34 pruebas (`cd backend && npm test`), incluidas las del adaptador de Turso.

## Pendiente
1. **Primer despliegue real:** el adaptador se probó contra un servidor simulado con el mismo protocolo, no contra Turso real. Revisar los logs de Vercel en el primer arranque.
2. **Gemini (lectura de PDF):** no probado contra el servicio real. Configurar `AI_PROVIDER=gemini` y `AI_API_KEY` en Vercel y verificar los límites gratuitos vigentes.
3. **Importación:** solo SQLite y CSV, hasta 4 MB en Vercel. PostgreSQL y MySQL requieren exportación previa.
4. **Interfaz:** verificada en escritorio; falta revisión en teléfono.
5. **Reporte Excel:** formato SpreadsheetML (.xls); Excel lo abre con una advertencia de formato.

## Cómo correr en local
- Backend: `cd backend && npm start` (Node 22.13+), abre http://localhost:4000.
- Pruebas: `cd backend && npm test`.
- Frontend: `cd frontend && npm install && node build.mjs`.
