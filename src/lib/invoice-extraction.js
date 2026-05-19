// INVOICE-OCR.1 — Claude Vision invoice extractor.
//
// Replaces the Dext-style outsourced OCR pipeline with an in-house
// call to the Anthropic Messages API (Claude Sonnet 4.6). Takes a
// stored car_documents row, downloads the file from Supabase
// Storage, sends it to Claude with a strict extraction prompt, and
// returns a validated JSON structure ready for Xero push.
//
// Why Claude Vision over a dedicated OCR API:
//   • Single vendor for both the assistant chat (already wired) +
//     invoice OCR. One API key, one rate-limit pool, one billing
//     line.
//   • Better fidelity on messy supplier invoices than Hubdoc/Dext.
//     Claude can disambiguate "Inv #" vs "PO #" vs "VAT #" by
//     context rather than position-on-page heuristics.
//   • Schema-locked output via the prompt; we don't depend on a
//     vendor-specific field naming convention.
//
// Shape returned to the caller:
//
//   {
//     ok: true,
//     fields: {
//       supplier_name: string,
//       supplier_address?: string,
//       invoice_number: string,
//       invoice_date: string (ISO date YYYY-MM-DD),
//       due_date?: string (ISO date),
//       currency: string (ISO 4217, e.g. 'EUR'),
//       subtotal: number,
//       tax_amount: number,
//       total: number,
//       line_items: [{
//         description: string,
//         quantity: number,
//         unit_amount: number,
//         account_code?: string,
//       }],
//     },
//     raw_response: string,
//   }
//
//   or { ok: false, error: string, raw_response?: string }
//
// Errors are returned, not thrown — the route handler decides how
// to surface them (400 vs 500). Logged via console.warn so the
// Vercel runtime logs have the context.

import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-4-6'

// Anthropic accepts PDF + a handful of image media types. Reject
// anything else early so we don't waste an API call on a docx or
// .heic that won't parse.
const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

// Zod schema for the JSON Claude returns. Loose on number parsing
// (Claude sometimes returns "€1,234.56" as a string) — coerce.
const lineItem = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().nonnegative(),
  unit_amount: z.coerce.number(),
  account_code: z.string().max(50).nullable().optional(),
})

const invoiceFields = z.object({
  supplier_name: z.string().min(1).max(300),
  supplier_address: z.string().max(1000).nullable().optional(),
  invoice_number: z.string().min(1).max(100),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD').nullable().optional(),
  currency: z.string().length(3).default('EUR'),
  subtotal: z.coerce.number(),
  tax_amount: z.coerce.number(),
  total: z.coerce.number(),
  line_items: z.array(lineItem).min(0).max(200),
})

export { invoiceFields as invoiceFieldsSchema }

const SYSTEM_PROMPT = `You are an invoice data extractor. The user will attach a single supplier invoice as a PDF or image. Extract the fields below into a JSON object and return ONLY the JSON — no prose, no markdown code fences, no commentary.

Required fields:
- supplier_name (string) — the company that issued the invoice
- supplier_address (string | null) — full address as a single line, null if not shown
- invoice_number (string) — the invoice's reference number / ID
- invoice_date (string) — ISO format YYYY-MM-DD. The date the invoice was issued.
- due_date (string | null) — ISO format YYYY-MM-DD, null if no due date shown
- currency (string) — ISO 4217 three-letter code; if you see € use "EUR", £ use "GBP", $ use "USD"
- subtotal (number) — pre-tax total
- tax_amount (number) — VAT / GST / sales tax total
- total (number) — invoice total including tax. Must equal subtotal + tax_amount within 0.01.
- line_items (array) — each line as { description, quantity, unit_amount, account_code (optional, null if none) }

Rules:
- Numbers must be JSON numbers, not strings. Strip currency symbols, commas, and any other formatting.
- Dates must be ISO format. If the invoice shows "12/03/2026" or "12 March 2026", convert to "2026-03-12".
- If a field is genuinely absent, use null (for optional fields) or your best inference from context (for required fields). Never invent supplier names or invoice numbers.
- Return ONLY the JSON object, starting with { and ending with }. No markdown fences. No "Here is the JSON:" preamble.`

/**
 * Download a car_document file from Supabase Storage and return it
 * as a base64 string suitable for an Anthropic image/document
 * content block.
 *
 * Returns { ok: true, base64, mediaType } or { ok: false, error }.
 */
async function fetchDocumentAsBase64(db, document) {
  if (!document?.storage_path) {
    return { ok: false, error: 'Document has no storage_path' }
  }
  if (!SUPPORTED_MIME.has(document.mime_type || '')) {
    return {
      ok: false,
      error: `Unsupported MIME type for OCR: ${document.mime_type || '(missing)'}. Supported: PDF, JPEG, PNG, GIF, WebP.`,
    }
  }

  // Use the storage client's download — works regardless of bucket
  // public/private settings since we're calling service-role.
  const { data: blob, error: dlErr } = await db.storage
    .from('car-documents')
    .download(document.storage_path)
  if (dlErr || !blob) {
    return { ok: false, error: `Storage download failed: ${dlErr?.message || 'unknown error'}` }
  }

  const arrayBuffer = await blob.arrayBuffer()
  const base64 = Buffer.from(arrayBuffer).toString('base64')

  return { ok: true, base64, mediaType: document.mime_type }
}

/**
 * Strip optional markdown fences + leading/trailing whitespace
 * before parsing JSON. Belt-and-braces; the system prompt says
 * "no fences" but Claude occasionally adds them anyway.
 */
function stripJsonFences(raw) {
  let s = (raw || '').trim()
  if (s.startsWith('```')) {
    // Remove the opening fence + optional language hint, then
    // close the trailing fence.
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  return s
}

/**
 * Pure extraction over raw bytes — no Supabase, no storage. Shared
 * by both the car_documents OCR (storage-backed) and the
 * INVOICES.1 inbound_invoices OCR (also storage-backed but a
 * different bucket) so the model+prompt path lives in one place.
 *
 * @param {Buffer|Uint8Array} bytes  the file contents
 * @param {string} mime              MIME type — must be in SUPPORTED_MIME
 * @returns {Promise<{ ok: true, fields, raw_response } | { ok: false, error, raw_response? }>}
 */
export async function extractInvoiceFieldsFromBytes(bytes, mime) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY is not configured.' }
  }
  if (!bytes || !bytes.length) {
    return { ok: false, error: 'No file bytes provided to extractor.' }
  }
  if (!SUPPORTED_MIME.has(mime || '')) {
    return {
      ok: false,
      error: `Unsupported MIME type for OCR: ${mime || '(missing)'}. Supported: PDF, JPEG, PNG, GIF, WebP.`,
    }
  }

  const base64 = Buffer.from(bytes).toString('base64')

  // The Anthropic Messages API takes different content-block types
  // for images vs PDFs. PDFs use type=document; images use
  // type=image. Same base64 transport, different envelope.
  const isPdf = mime === 'application/pdf'
  const documentBlock = isPdf
    ? {
        type: 'document',
        source: { type: 'base64', media_type: mime, data: base64 },
      }
    : {
        type: 'image',
        source: { type: 'base64', media_type: mime, data: base64 },
      }

  let claudeRes
  try {
    claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              documentBlock,
              {
                type: 'text',
                text: 'Extract the invoice fields per your system instructions. Return only the JSON object.',
              },
            ],
          },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, error: `Anthropic API request failed: ${e.message || String(e)}` }
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '<unreadable>')
    return { ok: false, error: `Anthropic API error (${claudeRes.status}): ${errText}` }
  }

  const claudeData = await claudeRes.json().catch(() => null)
  if (!claudeData) {
    return { ok: false, error: 'Anthropic returned non-JSON response body.' }
  }

  const textBlock = (claudeData.content || []).find((b) => b.type === 'text')
  const raw = textBlock?.text || ''
  if (!raw) {
    return { ok: false, error: 'Anthropic response contained no text block.', raw_response: JSON.stringify(claudeData) }
  }

  let parsed
  try {
    parsed = JSON.parse(stripJsonFences(raw))
  } catch (e) {
    return { ok: false, error: `Failed to parse extracted JSON: ${e.message}`, raw_response: raw }
  }

  const validation = invoiceFields.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      error: `Extracted JSON failed schema validation: ${validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      raw_response: raw,
    }
  }

  return { ok: true, fields: validation.data, raw_response: raw }
}

/**
 * Extract structured invoice fields from a stored car_document
 * row. Returns the validated object on success, or an error
 * envelope. Never throws — callers can branch on `ok`.
 *
 * Thin wrapper around extractInvoiceFieldsFromBytes that handles
 * the car_documents storage path.
 *
 * @param {string} documentId  car_documents.id
 * @returns {Promise<{ ok: true, fields, raw_response } | { ok: false, error, raw_response? }>}
 */
export async function extractInvoiceFields(documentId) {
  const db = createServerClient()

  const { data: document, error: loadErr } = await db
    .from('car_documents')
    .select('id, car_id, storage_path, mime_type, filename')
    .eq('id', documentId)
    .single()
  if (loadErr || !document) {
    return { ok: false, error: `Document not found: ${loadErr?.message || documentId}` }
  }

  const dl = await fetchDocumentAsBase64(db, document)
  if (!dl.ok) return dl

  const bytes = Buffer.from(dl.base64, 'base64')
  return extractInvoiceFieldsFromBytes(bytes, dl.mediaType)
}
