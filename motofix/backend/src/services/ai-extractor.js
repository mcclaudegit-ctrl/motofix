// Adaptador de lectura de facturas en PDF. Proveedor configurable por variables de entorno:
//   AI_PROVIDER=gemini   AI_API_KEY=<clave>   AI_MODEL=<modelo opcional, por defecto gemini-flash-latest>
// gemini-flash-latest es el alias que Google mantiene apuntando al Flash vigente: no falla cuando
// retiran una versión concreta (los nombres fijos responden 404 al darse de baja).
// Sin clave (o con AI_PROVIDER distinto) se usa extracción simulada y el sistema lo indica.
// La clave NUNCA se guarda en código ni en la base de datos. Toda extracción requiere revisión humana.
import { HttpError } from '../lib/http.js';

const PROMPT = `Extrae de esta factura de proveedor los campos en JSON con exactamente estas claves:
vendor_name, tax_id (solo dígitos), invoice_number, issue_date (AAAA-MM-DD), currency ("CRC" o "USD"),
subtotal, tax, total (números), category, bank_account. Usa null si un dato no aparece. No inventes datos.`;

export function extractorInfo() {
  const configured = (process.env.AI_PROVIDER || 'simulado').toLowerCase();
  const hasKey = Boolean(process.env.AI_API_KEY);
  const active = configured === 'gemini' && hasKey ? 'gemini' : 'simulado';
  return {
    provider: active,
    configured,
    hasKey,
    model: process.env.AI_MODEL || 'gemini-flash-latest',
    warning: configured === 'gemini' && !hasKey ? 'Falta AI_API_KEY: se usa extracción simulada' : null,
  };
}

/** Devuelve los campos extraídos. `fallback` se usa solo en modo simulado (datos de prueba). */
export async function extractFromPdf({ base64Pdf, fallback = null }) {
  const info = extractorInfo();
  if (info.provider !== 'gemini') {
    if (!fallback) throw new HttpError(422, 'EXTRACCION_NO_DISPONIBLE',
      'La lectura de PDF requiere un proveedor de IA configurado (AI_PROVIDER=gemini y AI_API_KEY). Registra la factura manualmente o importa XML/CSV.');
    return { provider: 'simulado', fields: fallback, warning: info.warning };
  }
  const base = (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(info.model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.AI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'application/pdf', data: base64Pdf } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new HttpError(502, 'PROVEEDOR_IA', 'No se pudo conectar con el proveedor de IA (sin respuesta o tiempo agotado)');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* sin cuerpo JSON */ }
    const why = {
      400: 'Solicitud rechazada (¿clave inválida o PDF ilegible?)',
      401: 'Clave de API inválida',
      403: 'La clave no tiene permiso para usar Gemini',
      404: `El modelo «${info.model}» no está disponible. Quita AI_MODEL para usar gemini-flash-latest`,
      429: 'Se agotó la cuota gratuita de Gemini. Intenta más tarde o revisa los límites en Google AI Studio',
    }[res.status] || `El proveedor de IA respondió ${res.status}`;
    throw new HttpError(502, 'PROVEEDOR_IA', detail ? `${why}. Detalle: ${detail.slice(0, 200)}` : `${why}.`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  if (!cand) throw new HttpError(502, 'RESPUESTA_IA', `El modelo no devolvió resultado${data?.promptFeedback?.blockReason ? ` (bloqueado: ${data.promptFeedback.blockReason})` : ''}`);
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); // por si el modelo envuelve el JSON en un bloque de código
  let fields;
  try { fields = JSON.parse(text); } catch { throw new HttpError(502, 'RESPUESTA_IA', 'La respuesta del modelo no es JSON válido'); }
  if (Array.isArray(fields)) fields = fields[0] || {};
  if (!fields || typeof fields !== 'object') throw new HttpError(502, 'RESPUESTA_IA', 'La respuesta del modelo no tiene el formato esperado');
  return { provider: 'gemini', model: data.modelVersion || info.model, fields };
}
