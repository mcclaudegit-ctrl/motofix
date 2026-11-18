# MotoFix · Gestión de taller de motocicletas

Aplicación web (backend + frontend) construida a partir del PRD y WBS de MotoFix: facturación con control anti-duplicación, inventario con ajuste automático, control de accesos por roles (RBAC), bitácora de auditoría inmutable y un motor de IA para detectar anomalías financieras, con monitor de cruce NIIF 15.

## Inicio rápido

Requisito: **Node.js 22.13 o superior**. No hay que instalar paquetes: el backend no tiene dependencias externas y el frontend ya viene compilado en `frontend/dist`.

```bash
cd backend
npm start          # → http://localhost:4000
```

La primera vez, si la base está vacía, carga ~60 días de datos sintéticos (clientes, órdenes, facturas, compras, y anomalías «plantadas» para demostrar el motor de IA). Para regenerarlos: `npm run seed`.

**Cuentas demo** (contraseña `MotoFix2026!`): `admin@`, `gerente@`, `contador@`, `recepcionista@`, `ventas@`, `proveedor1@`, `proveedor2@`, `proveedor3@` + `motofix.demo`.
En la pantalla de acceso hay botones de ingreso directo, y arriba a la derecha el **selector de rol («Modo demo · ver como»)** para cambiar de perfil en caliente.

## Qué recorrer en la demo

| Quiero ver… | Haz esto |
|---|---|
| Pop-up de seguridad | Entra como **Recepcionista** → Facturas → abre una → «Anular factura» (botón con candado) |
| Guardia de navegación | Como Recepcionista, abre `/auditoria` |
| Escaneo de IA | Entra como **Contador** → Motor de IA → «Escanear facturas»: recorre las facturas y resalta en rojo las sospechosas |
| Anti-duplicación | Emite dos veces la misma factura de venta el mismo día |
| Flujo de aprobación | Contador solicita anulación o descuento → Gerente la resuelve (nadie aprueba su propia solicitud) |
| Matriz de permisos | **Admin** → Control de accesos: quita un permiso y cambia de rol para ver el efecto inmediato |
| Bitácora inmutable | Contador → Auditoría → «Verificar integridad» y «Probar inmutabilidad» |
| Portal de proveedores | **Proveedor 1** → carga una factura; el Contador la aprueba y entra al inventario |
| NIIF 15 | Contabilidad → «Monitor NIIF 15» |

## Cuentas por pagar (CxP)

El producto se centra en la **revisión de cuentas por pagar**, con tres módulos:

1. **Entrada y limpieza de datos.** Registro manual, lectura de PDF (con un proveedor de IA configurable), importación de XML/CSV y bases SQLite externas en solo lectura. Estandariza nombres, cédulas, fechas, montos (₡/$), monedas, cuentas bancarias y categorías, y deja cada cambio en una bitácora (antes → después).
2. **Detector de anomalías.** Duplicados (mismo número, mismo monto y fecha, montos con fechas cercanas, la misma factura por dos canales), patrones irregulares (monto a ≤5% del límite, fraccionamiento para evadir el límite, monto atípico frente al historial, fecha futura, domingo) y coincidencia con el maestro de proveedores (no registrado, cédula con nombre distinto, cuenta bancaria cambiada, proveedor que es empleado).
3. **Dashboard y alertas de auditoría.** Clasifica cada factura en riesgo **Bajo / Medio / Alto** con un puntaje ponderado (pesos y umbrales editables), muestra las facturas críticas y genera reportes automáticos en PDF, Excel (.xlsx) y CSV, más un resumen semanal de riesgo.

**Aprobación.** Las facturas sobre **₡700.000** requieren dos aprobaciones de personas distintas. Quien registra una factura no puede aprobarla (segregación de funciones). Las facturas de riesgo alto exigen justificación escrita, y las que tienen datos mínimos incompletos o vienen de PDF no se pueden aprobar hasta confirmar su revisión.

**Bandeja de correo simulada.** Ficticia: no envía ni recibe correos reales. Tres botones generan facturas aleatorias según el nivel de cumplimiento:
- *Cumple con todo*: XML completo de proveedor registrado; se procesa sola.
- *Cumple parcialmente*: PDF sin XML y con formatos sucios; entra a revisión humana y se pide el XML.
- *No cumple del todo*: sin adjunto o con datos mínimos faltantes; queda bloqueada y se solicita información.

Regla de correo: siempre se avisa internamente; se responde al proveedor solo si falta el XML o los datos mínimos.

**Importación.** SQLite (.db/.sqlite, hasta 20 MB) y CSV. El archivo se abre en solo lectura, las tablas y columnas se validan antes de usarse, y el mapeo a campos CxP es explícito. PostgreSQL y MySQL no se conectan directamente: exporta a SQLite o CSV.

**Lectura de PDF.** Configura en Vercel `AI_PROVIDER=gemini` y `AI_API_KEY` (clave gratuita de Google AI Studio). Sin clave, la extracción es simulada y la pantalla lo indica. Por defecto usa el modelo `gemini-flash-latest`, un alias que Google mantiene apuntando al Flash vigente, así que no se rompe cuando retiran una versión. Con `AI_MODEL` se puede fijar otro. Los límites del plan gratuito cambian con frecuencia: revísalos en AI Studio. Si se agota la cuota, la app lo explica en el mensaje de error. La solicitud sigue la API `generateContent` (PDF en línea) y está probada contra un servidor simulado (`test/gemini.test.js`); falta probarla con una clave real.

**Roles nuevos.** *Auditor* (solo lectura: revisa facturas, hallazgos, bitácora y reportes; no aprueba ni modifica). Los roles de contador, gerente y administrador reciben los permisos `ap.*` según la matriz de accesos.

**Datos sintéticos.** La semilla incluye proveedores, empleados y facturas ficticias con anomalías plantadas (duplicados, fraccionamiento, cuenta cambiada, proveedor que es empleado, monto atípico, factura en domingo y proveedor no registrado).

Pruebas: `npm test` en `backend/` (suite original y `test/ap.test.js` para CxP).

## Publicar en Vercel (gratis, uso no comercial)

Vercel no guarda archivos entre solicitudes, así que en la nube la base vive en **Turso** (SQLite administrado, plan gratuito). En local todo sigue igual: sin variables de Turso se usa `backend/data/motofix.db`.

**1. Crea la base en Turso** (https://turso.tech, puedes entrar con GitHub)
- Crea una base llamada `motofix` en la región de **AWS US East (Virginia)**, la misma de la función de Vercel (`iad1`). Si quedan en regiones distintas, cada consulta tarda mucho más.
- Copia la URL de la base (`libsql://motofix-<usuario>.turso.io`) y crea un token de lectura y escritura.

**2. Importa el repositorio en Vercel** (https://vercel.com/new)
- Framework: *Other*. No cambies el directorio raíz ni los comandos: `vercel.json` ya los define (no hay que compilar nada).
- Variables de entorno (*Settings → Environment Variables*):

| Variable | Valor |
|---|---|
| `TURSO_DATABASE_URL` | la URL `libsql://…` de Turso |
| `TURSO_AUTH_TOKEN` | el token de Turso |
| `JWT_SECRET` | texto aleatorio largo (p. ej. `openssl rand -hex 32`) |
| `CRON_SECRET` | opcional: texto aleatorio; restringe el cron diario a Vercel y permite reiniciar la demo |
| `DEMO_MODE` | `true` para la demo con selector de rol; `false` para uso real |
| `AI_PROVIDER`, `AI_API_KEY` | opcionales, para leer PDF con Gemini |

**3. Carga los datos de demostración** (una sola vez), abriendo en el navegador:
`https://<tu-app>.vercel.app/api/setup`
Solo funciona con la base vacía. Para borrar todo y recargar la demo: `/api/setup?clave=<CRON_SECRET>&reiniciar=1`.
Con la integración de Turso del Marketplace de Vercel (*Storage → Create Database → Turso*), `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` se configuran solas; sin `JWT_SECRET`, el secreto de sesión se deriva del token de Turso.
También se puede hacer desde tu computadora: `cd backend && TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run turso:init`.

**Diferencias frente al servidor propio**
- El motor de IA se re-evalúa al consultar el dashboard, las notificaciones o el módulo de IA (máximo una vez por minuto), después de cada factura, y en un cron diario (`/api/cron/tick`, el plan Hobby permite uno al día). El reporte semanal de riesgo se genera desde ese cron.
- Las importaciones aceptan archivos de hasta **4 MB** (Vercel limita el cuerpo de una solicitud a 4,5 MB).
- El límite de intentos de inicio de sesión es por instancia.
- El plan Hobby de Vercel es solo para uso personal y no comercial.

**Cómo funciona** (`backend/src/lib/libsql/`): un cliente HTTP del protocolo de Turso (Hrana v2) con la misma interfaz síncrona que `node:sqlite`. Así no cambió la lógica de negocio. La petición la hace un *worker* y el hilo principal espera con `Atomics.wait`, de modo que las solicitudes de una instancia se atienden una a la vez y las transacciones conservan su semántica. `test/remote.test.js` lo prueba contra un servidor simulado (`test/helpers/fake-hrana.js`); para correr todas las pruebas contra él: `node test/helpers/fake-hrana.js 8080 /tmp/r.db` y luego `TURSO_DATABASE_URL=http://127.0.0.1:8080 TURSO_AUTH_TOKEN=tok node --test test/api.test.js`.

## Cobertura del PRD / WBS

| WBS | Implementado en |
|---|---|
| 1.1.1 Selector de rol | Barra superior (modo demo) |
| 1.1.2 Sidebar dinámico | Menú generado según permisos del rol |
| 1.1.3 Dashboard + alertas IA | `/` (ejecutivo para Admin/Gerente/Contador; operativo para Recepción/Ventas); sondeo cada 10 s |
| 1.1.4 Pop-ups de permiso denegado | Modal de seguridad ante cualquier 403 / duplicado / intento de alterar la bitácora |
| 1.2.1–1.2.2 Perfiles internos/externos | `/accesos` (usuarios; máx. **3** externos) y `/portal` |
| 1.2.3 Guardias y botones por privilegio | Rutas con permisos + botones ocultos o bloqueados; **el servidor siempre revalida** |
| 1.3.1 Emisión de facturas | `/facturas/nueva` (IVA 13 %, precios de catálogo, consecutivo automático) |
| 1.3.2 Compras (3 proveedores) | `/compras` y portal |
| 1.3.3 Validador anti-duplicación | Hash SHA-256 (cliente + líneas + monto + día) y consecutivo; el Gerente puede autorizar un duplicado legítimo con justificación |
| 1.3.4 Anulaciones / descuentos | `/aprobaciones` (segregación de funciones) |
| 1.4.1–1.4.3 Inventario | Catálogo, ajuste automático por factura/compra/anulación, discrepancia repuestos usados vs. facturados |
| 1.5.1 Motor de IA | 20+ reglas: duplicados, montos atípicos (z-score robusto en escala log), horarios, consecutivos faltantes, descuentos, ráfagas, accesos denegados repetidos, permisos alterados, proveedores… |
| 1.5.2 Bitácora inmutable | Tabla append-only con **triggers SQL** + cadena de hashes SHA-256 verificable |
| 1.5.3 Monitor NIIF 15 | Orden de trabajo vs. factura: reconocimiento prematuro, sin facturar, diferencias, descuentos sin aprobar |
| 1.6.x Datos | SQLite (`backend/data/motofix.db`), eventos de auditoría y mock data sintética (`backend/src/seed.js`) |

Matriz de roles por defecto: `backend/src/permissions.js` (editable luego desde la app).

## Arquitectura

```
backend/   Node 22 sin dependencias: node:http + node:sqlite + node:crypto
  src/lib/        mini-framework HTTP, JWT HS256, scrypt, validación
  src/auth.js     autenticación + RBAC (bloquea, registra y notifica)
  src/audit.js    bitácora encadenada
  src/anomaly.js  motor de IA     src/niif15.js  monitor contable
  src/services/   reglas de negocio de facturación
  src/routes/     API REST        test/  34 pruebas (npm test)
frontend/  React 19 + esbuild (iconos: react-icons)
  src/pages/      una pantalla por módulo     build.mjs  compila a dist/
```

Para modificar el frontend: `cd frontend && npm install && npm run build` (o `npm run dev` para recompilar al guardar).

## Antes de pasar a producción

- `DEMO_MODE=false` y `AUTO_SEED=false` (ver `backend/.env.example`), `JWT_SECRET` propio y contraseñas nuevas para todas las cuentas.
- Publicar detrás de **HTTPS** (Caddy/nginx) con `TRUST_PROXY=true` para registrar la IP real.
- La «IA» es **estadística y reglas explicables** (sin modelo de lenguaje): cada alerta indica por qué se generó y es idempotente. Se puede ampliar con un modelo de ML sobre el mismo flujo.
- El monitor NIIF 15 es una ayuda de control interno; no sustituye el criterio del contador.
- SQLite en un solo proceso es adecuado para un taller; en la nube se usa Turso (ver «Publicar en Vercel»).
- `node:sqlite` es API experimental de Node 22 (el aviso se silencia en los scripts).
- Respaldos: copiar periódicamente `backend/data/motofix.db`.
