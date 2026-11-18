import { config } from './config.js';
import { get } from './db.js';
import { createApp } from './lib/http.js';
import { buildRouter } from './routes/index.js';
import { detect } from './anomaly.js';
import { seed } from './seed.js';
import { ensureApDefaults } from './services/ap.js';
import { runScheduledReports } from './services/ap-report.js';

if (config.autoSeed && !get('SELECT COUNT(*) n FROM users').n) {
  console.log('[motofix] Base vacía: cargando datos sintéticos de demostración…');
  await seed();
}

ensureApDefaults();
const server = createApp(buildRouter());
server.listen(config.port, () => {
  console.log(`\n  MotoFix API + web  →  http://localhost:${config.port}`);
  console.log(`  Modo demo (selector de rol): ${config.demoMode ? 'ACTIVADO' : 'desactivado'}`);
  console.log(`  Frontend: ${config.staticDir}\n`);
});

// El Auditor Inteligente vigila de forma continua: re-evalúa cada 30 s (idempotente).
setInterval(() => { try { detect(); } catch (e) { console.error('[auditor-inteligente]', e); } }, 30_000).unref();

// Reporte automático semanal de riesgo CxP (revisa cada hora si toca generarlo).
setInterval(() => { try { runScheduledReports(); } catch (e) { console.error('[cxp-reportes]', e); } }, 3_600_000).unref();
