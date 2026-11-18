// Lectura de PDF con Gemini contra un servidor que imita la API (sin red ni clave real).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server; let mode = 'ok'; let last = null;
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      last = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) };
      if (mode === 'quota') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Resource has been exhausted"}}'); }
      if (mode === 'gone') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"models/x is not found"}}'); }
      const fields = { vendor_name: 'Repuestos del Pacífico', tax_id: '3101123456', invoice_number: 'FE-001', issue_date: '2026-11-10', currency: 'CRC', subtotal: 100000, tax: 13000, total: 113000, category: 'Repuestos', bank_account: null };
      const text = mode === 'fenced' ? '```json\n' + JSON.stringify(fields) + '\n```' : JSON.stringify(fields);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], modelVersion: 'gemini-x-flash' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.AI_PROVIDER = 'gemini'; process.env.AI_API_KEY = 'clave-de-prueba';
  process.env.AI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.AI_MODEL;
});
after(() => { server.close(); delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL; });

const { extractFromPdf, extractorInfo } = await import('../src/services/ai-extractor.js');
const pdf = Buffer.from('%PDF-1.4 prueba').toString('base64');

test('usa el alias gemini-flash-latest y envía el PDF en línea con la clave en cabecera', async () => {
  mode = 'ok';
  assert.equal(extractorInfo().model, 'gemini-flash-latest');
  const r = await extractFromPdf({ base64Pdf: pdf });
  assert.equal(last.url, '/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(last.key, 'clave-de-prueba');
  const part = last.body.contents[0].parts[1].inline_data;
  assert.equal(part.mime_type, 'application/pdf'); assert.equal(part.data, pdf);
  assert.equal(last.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.provider, 'gemini'); assert.equal(r.model, 'gemini-x-flash'); assert.equal(r.fields.total, 113000);
});

test('acepta JSON envuelto en bloque de código', async () => {
  mode = 'fenced';
  const r = await extractFromPdf({ base64Pdf: pdf });
  assert.equal(r.fields.invoice_number, 'FE-001');
});

test('errores claros: cuota agotada y modelo retirado', async () => {
  mode = 'quota';
  await assert.rejects(extractFromPdf({ base64Pdf: pdf }), /cuota gratuita/);
  mode = 'gone';
  await assert.rejects(extractFromPdf({ base64Pdf: pdf }), /no está disponible/);
});
