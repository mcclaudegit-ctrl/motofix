// Uso (desde backend/):  TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run turso:init [-- --force]
// Crea el esquema en Turso y carga los datos de demostración. Sin --force no toca una base con datos.
if (!process.env.TURSO_DATABASE_URL) { console.error('Define TURSO_DATABASE_URL y TURSO_AUTH_TOKEN.'); process.exit(1); }
const { db, get, resetData, TRIGGERS_SQL } = await import('../db.js');
const { seedToFile, copyToRemote } = await import('./turso-copy.js');
const users = get('SELECT COUNT(*) n FROM users').n;
if (users && !process.argv.includes('--force')) {
  console.error(`La base remota ya tiene ${users} usuario(s). Usa --force para borrarla y recargar la demo.`);
  process.exit(1);
}
console.log('Generando datos de demostración…');
const { file, log } = seedToFile();
console.log(log);
console.log('Copiando a Turso…');
const { counts } = copyToRemote(file, db, { resetData, triggersSql: TRIGGERS_SQL, mode: 'reset' });
console.log(Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`).join(' · '));
console.log('Listo.');
db.close();
