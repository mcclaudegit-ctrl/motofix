// Servidor Hrana v2 mínimo para pruebas: node test/helpers/fake-hrana.js <puerto> <archivo.db> [msInactividad]
// Servidor Hrana v2 mínimo sobre node:sqlite para probar el cliente remoto sin Turso.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
const [port, file, idleMs = '3000'] = process.argv.slice(2);
const streams = new Map();
let requests = 0;
const open = () => new DatabaseSync(file);
const toJs = (v) => v.type === 'null' ? null : v.type === 'integer' ? BigInt(v.value) : v.type === 'float' ? Number(v.value) : v.type === 'text' ? v.value : Buffer.from(v.base64, 'base64');
const toH = (v) => v === null ? { type: 'null' } : typeof v === 'bigint' ? { type: 'integer', value: String(v) } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : typeof v === 'string' ? { type: 'text', value: v } : { type: 'blob', base64: Buffer.from(v).toString('base64') };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    requests++;
    if (req.url === '/stats') { res.end(JSON.stringify({ requests, streams: streams.size })); return; }
    if (req.url !== '/v2/pipeline' || req.headers.authorization !== 'Bearer tok') { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const p = JSON.parse(body);
    let st;
    if (p.baton) { st = streams.get(p.baton); if (!st) { res.writeHead(400); res.end(JSON.stringify({ error: 'The stream has expired due to inactivity' })); return; } streams.delete(p.baton); clearTimeout(st.t); }
    else st = { db: open() };
    const results = []; let closed = false;
    for (const r of p.requests) {
      try {
        if (r.type === 'close') { closed = true; results.push({ type: 'ok', response: { type: 'close' } }); continue; }
        if (r.type === 'sequence') { st.db.exec(r.sql); results.push({ type: 'ok', response: { type: 'sequence' } }); continue; }
        const stmt = st.db.prepare(r.stmt.sql); stmt.setReadBigInts(true);
        const args = (r.stmt.args || []).map(toJs);
        const cols = stmt.columns().map((c) => ({ name: c.name }));
        let rows = [], info = { changes: 0, lastInsertRowid: 0 };
        if (cols.length) rows = stmt.all(...args).map((o) => cols.map((c) => toH(o[c.name])));
        else info = stmt.run(...args);
        results.push({ type: 'ok', response: { type: 'execute', result: { cols, rows, affected_row_count: Number(info.changes), last_insert_rowid: cols.length ? null : String(info.lastInsertRowid) } } });
      } catch (e) { results.push({ type: 'error', error: { message: `SQLite error: ${e.message}`, code: 'SQLITE_ERROR' } }); }
    }
    let baton = null;
    if (closed) st.db.close(); else { baton = crypto.randomUUID(); st.t = setTimeout(() => { streams.delete(baton); st.db.close(); }, Number(idleMs)); streams.set(baton, st); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ baton, base_url: null, results }));
  });
}).listen(Number(port), () => console.log('fake hrana on', port));
