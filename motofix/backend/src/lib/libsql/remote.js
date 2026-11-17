// Cliente libSQL/Turso por HTTP (protocolo Hrana v2, /v2/pipeline) con API SÍNCRONA,
// compatible con el subconjunto de `DatabaseSync` (node:sqlite) que usa MotoFix:
// exec(sql) y prepare(sql).all/get/run(...params).
//
// Por qué síncrono: todo el backend se escribió sobre node:sqlite (síncrono). En vez de
// reescribir cientos de llamadas a async, cada consulta se envía desde un worker y el hilo
// principal espera con Atomics.wait. Las solicitudes quedan serializadas por instancia, lo
// que además conserva la semántica de las transacciones (BEGIN … COMMIT) del código original.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const TIMEOUT_MS = Number(process.env.TURSO_TIMEOUT_MS || 20_000);

export class RemoteDatabase {
  constructor(url, authToken) {
    if (!url) throw new Error('Falta TURSO_DATABASE_URL');
    this.baseUrl = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.headers = { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) };
    this.baton = null;          // sesión (stream) abierta en el servidor: conserva PRAGMAs y transacciones
    this.inTx = false;
    this.foreignKeys = true;    // PRAGMA de sesión que se reaplica si el stream expira
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { port: port2, flag: this.flag.buffer }, transferList: [port2] });
    this.worker.unref();
    this.port.unref?.();
  }

  // ---- transporte ----
  #post(body) {
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ url: `${this.baseUrl}/v2/pipeline`, headers: this.headers, body: JSON.stringify(body), timeoutMs: TIMEOUT_MS });
    const r = Atomics.wait(this.flag, 0, 0, TIMEOUT_MS + 2_000);
    const got = receiveMessageOnPort(this.port);
    if (!got) throw new Error(r === 'timed-out' ? 'Turso no respondió a tiempo' : 'Sin respuesta del worker de Turso');
    const m = got.message;
    if (m.error) throw new Error(`No se pudo conectar con Turso: ${m.error}`);
    let json;
    try { json = JSON.parse(m.text); } catch { json = null; }
    if (m.status !== 200) {
      const err = new Error(`Turso HTTP ${m.status}: ${json?.message || json?.error || m.text.slice(0, 200)}`);
      err.httpStatus = m.status;
      throw err;
    }
    return json;
  }

  /** Envía peticiones Hrana dentro del stream de sesión; si el stream expiró, abre uno nuevo. */
  #pipeline(requests) {
    const send = () => {
      const prefix = this.baton ? [] : [{ type: 'execute', stmt: { sql: `PRAGMA foreign_keys = ${this.foreignKeys ? 'ON' : 'OFF'}`, want_rows: false } }];
      const out = this.#post({ baton: this.baton, requests: [...prefix, ...requests] });
      this.baton = out.baton ?? null;
      if (out.base_url) this.baseUrl = out.base_url.replace(/\/+$/, '');
      return out.results.slice(prefix.length);
    };
    try {
      return send();
    } catch (e) {
      // Stream vencido por inactividad: se reintenta en uno nuevo (nunca a mitad de una transacción).
      if (this.baton && !this.inTx && e.httpStatus && e.httpStatus < 500) { this.baton = null; return send(); }
      this.baton = null;
      if (this.inTx) this.inTx = false;
      throw e;
    }
  }

  static #check(result) {
    if (result.type === 'error') {
      const e = new Error(result.error?.message || 'Error de base de datos');
      e.code = result.error?.code;
      throw e;
    }
    return result.response;
  }

  // ---- API compatible con DatabaseSync ----
  exec(sql) {
    const s = sql.trim();
    const kw = s.replace(/;$/, '').toUpperCase();
    for (const m of s.matchAll(/PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|1|0|TRUE|FALSE)/gi)) this.foreignKeys = /ON|1|TRUE/i.test(m[1]);
    // PRAGMAs de rendimiento locales no aplican (ni se permiten) en el servidor.
    const cleaned = s.replace(/PRAGMA\s+(journal_mode|synchronous|busy_timeout)\s*=\s*[^;]+;?/gi, '').trim();
    if (!cleaned) return;
    if (/^BEGIN\b/.test(kw)) this.inTx = true;
    try {
      RemoteDatabase.#check(this.#pipeline([{ type: 'sequence', sql: cleaned }])[0]);
    } finally {
      if (/^(COMMIT|ROLLBACK|END)\b/.test(kw)) this.inTx = false;
    }
  }

  prepare(sql) {
    const execute = (params) => {
      const res = RemoteDatabase.#check(this.#pipeline([{ type: 'execute', stmt: { sql, args: params.map(toValue), want_rows: true } }])[0]);
      return res.result;
    };
    const rows = (result) => {
      const names = result.cols.map((c) => c.name);
      return result.rows.map((r) => {
        const o = Object.create(null);
        names.forEach((n, i) => { o[n] = fromValue(r[i]); });
        return o;
      });
    };
    return {
      all: (...p) => rows(execute(p)),
      get: (...p) => rows(execute(p))[0],
      run: (...p) => {
        const r = execute(p);
        return { changes: r.affected_row_count, lastInsertRowid: r.last_insert_rowid == null ? 0 : Number(r.last_insert_rowid) };
      },
    };
  }

  /** Ejecuta muchas sentencias en una sola petición HTTP (carga masiva). Lanza ante el primer error. */
  executeBatch(stmts) {
    const results = this.#pipeline(stmts.map(({ sql, args = [] }) => ({ type: 'execute', stmt: { sql, args: args.map(toValue), want_rows: false } })));
    results.forEach((r) => RemoteDatabase.#check(r));
    return results.length;
  }

  close() {
    try { if (this.baton) this.#post({ baton: this.baton, requests: [{ type: 'close' }] }); } catch { /* ignorar */ }
    this.baton = null;
    this.worker.terminate();
  }
}

// node:sqlite enlaza los números de JS como REAL: se replica para obtener datos idénticos.
function toValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'float', value: v };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  if (v instanceof ArrayBuffer) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  throw new TypeError(`Tipo de parámetro no soportado: ${typeof v}`);
}

function fromValue(v) {
  switch (v?.type) {
    case 'integer': return Number(v.value);
    case 'float': return Number(v.value);
    case 'text': return v.value;
    case 'blob': return new Uint8Array(Buffer.from(v.base64, 'base64'));
    default: return null;
  }
}
