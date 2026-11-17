// Hilo auxiliar del puente síncrono: hace la petición HTTP (fetch es asíncrono) y
// despierta al hilo principal con Atomics cuando la respuesta está lista.
import { workerData } from 'node:worker_threads';

const { port, flag } = workerData;
const signal = new Int32Array(flag);

port.on('message', async ({ url, headers, body, timeoutMs }) => {
  let msg;
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    msg = { status: res.status, text: await res.text() };
  } catch (e) {
    msg = { error: e?.name === 'TimeoutError' ? `Tiempo de espera agotado (${timeoutMs} ms)` : String(e?.cause?.message || e?.message || e) };
  }
  port.postMessage(msg);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
