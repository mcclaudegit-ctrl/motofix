// Adaptador de lectura de facturas en PDF. Proveedor configurable por variables de entorno:
//   AI_PROVIDER=gemini   AI_API_KEY=<clave>   AI_MODEL=<modelo opcional>
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
    model: process.env.AI_MODEL || 'gemini-2.5-flash',
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(info.model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.AI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'application/pdf', data: base64Pdf } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, 'PROVEEDOR_IA', 'No se pudo conectar con el proveedor de IA');
  }
  if (!res.ok) throw new HttpError(502, 'PROVEEDOR_IA', `El proveedor de IA respondió ${res.status}. Revisa la clave o los límites del plan gratuito.`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let fields;
  try { fields = JSON.parse(text); } catch { throw new HttpError(502, 'RESPUESTA_IA', 'La respuesta del modelo no es JSON válido'); }
  return { provider: 'gemini', fields };
}
