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
import { INVOICE_CATEGORIES } from './invoice-categories'
import { anthropicMessages } from '@/lib/anthropic'

/**
 * Convert a HEIC/HEIF image (HEVC-encoded — the iPhone default) to JPEG so
 * Claude vision can read it. sharp's prebuilt libvips has NO HEVC decoder
 * (AVIF only — `sharp.format.heif.input.fileSuffix` is `['.avif']`), so this
 * uses heic-convert (libheif-js WASM). Lazy-imported; heic-convert + libheif-js
 * are in next.config `serverExternalPackages` so the WASM ships to the Vercel
 * runtime instead of being bundled.
 * @param {Buffer|Uint8Array} bytes  HEIC/HEIF bytes
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function heicToJpeg(bytes) {
  const convert = (await import('heic-convert')).default
  const out = await convert({ buffer: Buffer.from(bytes), format: 'JPEG', quality: 0.85 })
  return Buffer.from(out)
}

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

/**
 * MIME-SNIFF.1 — identify a document from its own first bytes.
 *
 * The stored mime is not trustworthy. `invoices_queue.attachment_mime_type`
 * is set by whichever enqueue path created the row, and one of them
 * (contractor invoices) hard-coded 'application/pdf' for years because its
 * source column is named `pdf_path`. A contractor's phone photo therefore
 * arrived labelled PDF, went into the `document` branch below, and Anthropic
 * rejected it: "The PDF specified was not valid" (400) — an error that says
 * nothing about the real cause.
 *
 * Sniffing closes the class at the only place that holds the actual bytes,
 * so a wrong label anywhere upstream — any source, past or future — can no
 * longer pick the wrong content block.
 *
 * Returns null when the bytes match nothing known: the caller then falls
 * back to the declared mime and the SUPPORTED_MIME gate reports a clear
 * unsupported-type error. Deliberately narrow — these five are exactly what
 * Anthropic accepts, and guessing beyond the signature would reintroduce
 * the "confident but wrong" failure this removes.
 *
 * @param {Buffer|Uint8Array|null} bytes
 * @returns {string|null} one of SUPPORTED_MIME, or null if unrecognised
 */
export function sniffMimeFromBytes(bytes) {
  if (!bytes || bytes.length < 4) return null
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const starts = (...sig) => sig.every((byte, i) => b[i] === byte)

  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'          // %PDF
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'                // GIF8
  // WebP is a RIFF container: 'RIFF' ....(size).... 'WEBP'. Both halves
  // must match — a .wav is also RIFF and must not be called an image.
  if (starts(0x52, 0x49, 0x46, 0x46) && b.length >= 12 && b.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

// Zod schema for the JSON Claude returns. Loose on number parsing
// (Claude sometimes returns "€1,234.56" as a string) — coerce.
// INVOICES — default the due date to 30 days after the issue date when
// the supplier didn't give one. Many invoices (e.g. the transport
// supplier) either omit a due date or echo the issue date; net-30 is
// the house default. Only fills when due_date is missing OR equals the
// invoice_date (the echo case) — a genuinely different due date is left
// untouched. Pure + deterministic so it's unit-testable.
export function addDaysIso(iso, days) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const d = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function applyDueDateDefault(fields) {
  if (!fields || !fields.invoice_date) return fields
  if (fields.due_date && fields.due_date !== fields.invoice_date) return fields
  const due = addDaysIso(fields.invoice_date, 30)
  return due ? { ...fields, due_date: due } : fields
}

const lineItem = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().nonnegative(),
  unit_amount: z.coerce.number(),
  account_code: z.string().max(50).nullable().optional(),
})

// INVOICES.3 — top-level category suggestion. A fixed enum so the
// dropdown in the inbox UI has a stable contract and the field can
// be aggregated for reporting later. Designed around how a gym
// actually spends money — generic "other" catches everything else.
//
// Mapped to Xero account codes per-location later (kept out of this
// lib so the OCR is org-agnostic). The forwarded email body
// includes the category as a hint to the bookkeeper finishing the
// draft in Xero.
const invoiceFields = z.object({
  supplier_name: z.string().min(1).max(300),
  supplier_address: z.string().max(1000).nullable().optional(),
  // RECEIPT-NULLS.1 — nullable, because a till receipt is not an invoice:
  // it routinely carries no invoice number, and often no date the model can
  // read off a crumpled thermal print. Both were required, so Claude
  // correctly answering `null` failed validation and the WHOLE extraction
  // was binned — supplier, total and line items included. That killed a
  // Tesco receipt (invoice_date, row ee83a2f6) and a card receipt
  // (invoice_number, e216cb1b) outright, with the operator shown only a
  // schema error.
  //
  // The pipeline was always built for a partial read:
  // scoreExtractionConfidence() scores a payload missing either field as
  // 'medium', and the /extract route notes "Operator always reviews
  // regardless". The schema was just stricter than the pipeline it feeds.
  // The regex still applies when a value IS present, so nullable does not
  // mean "anything goes", and push-xero blocks the Xero send if the
  // operator never fills the date in.
  invoice_number: z.string().min(1).max(100).nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD').nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD').nullable().optional(),
  currency: z.string().length(3).default('EUR'),
  subtotal: z.coerce.number(),
  tax_amount: z.coerce.number(),
  total: z.coerce.number(),
  // INVOICES.3 — top-level category. Optional because the existing
  // car_documents invoice flow doesn't ask for one (we only added
  // the prompt instruction for the inbound_invoices path). Validated
  // against the enum so the inbox UI can rely on the value if set.
  category: z.enum(INVOICE_CATEGORIES).nullable().optional(),
  // INVOICES.3 — operator-editable account code free-text field.
  // Claude can suggest one if the supplier maps obviously to a
  // standard chart-of-accounts entry; otherwise this stays null and
  // the operator fills it in (or leaves it for Xero's own OCR to
  // assign during the draft-bill flow).
  account_code: z.string().max(50).nullable().optional(),
  // XERO-API.2 — Xero AccountID for the picked chart-of-accounts
  // line (uuid-shaped string from /Accounts). Mirrored alongside
  // account_code (the human-visible code, e.g. "400") so the
  // existing audit / hint surfaces still read it.
  xero_account_id: z.string().max(100).nullable().optional(),
  // XERO-API.2 — structured ref for the picked supplier. Two shapes:
  //   { kind: 'existing', xero_contact_id, name, email? }
  //   { kind: 'new', name }
  // PR 3's /Invoices push branches on .kind: existing → attach
  // ContactID; new → upsertSupplierContact (creates inline) then
  // attach the new ContactID.
  xero_contact_ref: z.union([
    z.object({
      kind: z.literal('existing'),
      xero_contact_id: z.string().min(1).max(100),
      name: z.string().min(1).max(500),
      email: z.string().email().max(320).nullable().optional(),
    }),
    z.object({
      kind: z.literal('new'),
      name: z.string().min(1).max(500),
    }),
  ]).nullable().optional(),
  // XERO-BILL-VAT.2 — the confirmed Xero TaxType for this bill,
  // derived from the location's synced rates and confirmed by the
  // bookkeeper in review. Sent as LineItem.TaxType on push. Optional
  // so legacy rows + the car-invoice flow validate unchanged.
  tax_type: z.string().max(50).nullable().optional(),
  // 'derived' (auto-matched) | 'manual' (operator overrode). Audit only.
  tax_type_source: z.enum(['derived', 'manual']).nullable().optional(),
  // XERO-BILL-SUMMARY.1 — the bill posts to Xero as one summary line, so
  // itemised lines are no longer extracted (the prompt tells the model to
  // omit them). Kept optional + accepted if a legacy row / other caller
  // still supplies them, but nothing downstream reads them.
  line_items: z.array(lineItem).min(0).max(200).optional().default([]),
})

export { invoiceFields as invoiceFieldsSchema }

const SYSTEM_PROMPT = `You are an invoice data extractor for a chain of gym studios in Ireland. The user will attach a single supplier invoice as a PDF or image. Extract the fields below into a JSON object and return ONLY the JSON — no prose, no markdown code fences, no commentary.

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
- category (string | null) — one of: utilities, cleaning, equipment, marketing, insurance, rent, maintenance, professional_services, staff_training, office_supplies, software, bank_fees, other. Pick the SINGLE best match for the whole invoice based on the supplier name and what the invoice is for. Use null only if genuinely unclear.
- account_code (string | null) — only suggest a value if the supplier matches an obvious accounting category (e.g. an electric utility → "Utilities" account code if visible on the invoice). Otherwise null and let the operator decide.

Category guidance:
- utilities: electricity, gas, water, internet, phone, broadband
- cleaning: cleaning services, sanitiser, paper goods, mops, bin liners
- equipment: gym equipment, weights, racks, treadmills, rowers, fit-out
- marketing: ad spend, design services, photography, video, social media tooling
- insurance: any insurance premium (public liability, contents, employer's liability)
- rent: studio space rent, lease payments
- maintenance: HVAC servicing, equipment repairs, plumbing, electrical, building works
- professional_services: accountancy, legal, consultancy, financial advice
- staff_training: PT certifications, courses, conferences for staff
- office_supplies: stationery, printer cartridges, low-value office goods
- software: SaaS subscriptions, Glofox, Stripe, Xero, accounting tools, scheduling tools
- bank_fees: bank charges, merchant processor fees not tied to a transaction
- other: anything that doesn't fit cleanly into one of the above

Rules:
- Do NOT itemise the invoice. We only need the header figures above (subtotal, tax_amount, total) plus the supplier and invoice number — the bill is posted to the accounts system as a single summary line and the full invoice is filed as an attachment, so per-line detail is unnecessary and error-prone (metered / "per 1,000,000" usage lines especially). Omit line_items entirely.
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
 * @param {{ locationId?: string|null }} [meta] SAAS4-M1 — tenant tag for usage metering
 * @returns {Promise<{ ok: true, fields, raw_response } | { ok: false, error, raw_response? }>}
 */
export async function extractInvoiceFieldsFromBytes(bytes, mime, meta = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY is not configured.' }
  }
  if (!bytes || !bytes.length) {
    return { ok: false, error: 'No file bytes provided to extractor.' }
  }
  // iPhone receipts default to HEIC (HEVC-encoded), which Claude vision can't
  // parse. sharp's prebuilt libvips has no HEVC decoder, so heicToJpeg() uses
  // heic-convert (libheif-js WASM). On any conversion failure, return a clear,
  // actionable error rather than a silent stall.
  if (mime === 'image/heic' || mime === 'image/heif') {
    try {
      bytes = await heicToJpeg(bytes)
      mime = 'image/jpeg'
    } catch {
      return { ok: false, error: 'This looks like a HEIC image (iPhone default) we could not convert. Please re-upload the receipt as JPEG or PDF.' }
    }
  }
  // MIME-SNIFF.1 — the bytes outrank the label. Done AFTER the HEIC branch
  // (which rewrites both) and BEFORE the support gate, so a row whose stored
  // mime is wrong is corrected rather than rejected, and a row whose mime is
  // missing entirely can still be processed. Only overrides when the sniff
  // recognises the signature; an unknown one leaves the declared mime to be
  // judged by the gate below.
  const sniffed = sniffMimeFromBytes(bytes)
  if (sniffed && sniffed !== mime) {
    // Not an error: the queue row simply disagreed with the file. Worth a
    // line because a mislabelled row means an upstream enqueue path is
    // guessing (that is how contractor invoices shipped as fake PDFs).
    console.warn(`[invoice-extraction] declared mime ${mime || '(missing)'} but bytes are ${sniffed} — trusting the bytes`)
    mime = sniffed
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

  let claudeRes, claudeData
  try {
    // SAAS4-M1 — metered via the shared wrapper (source: invoice_ocr).
    ;({ res: claudeRes, data: claudeData } = await anthropicMessages(
      {
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
      },
      { apiKey, locationId: meta.locationId ?? null, source: 'invoice_ocr' }
    ))
  } catch (e) {
    return { ok: false, error: `Anthropic API request failed: ${e.message || String(e)}` }
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '<unreadable>')
    return { ok: false, error: `Anthropic API error (${claudeRes.status}): ${errText}` }
  }
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

  return { ok: true, fields: applyDueDateDefault(validation.data), raw_response: raw }
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

/**
 * Confidence hint for extracted fields — 'high' when every required
 * field is present AND subtotal + tax reconciles to total within €0.01,
 * else 'medium'. Pure; the operator always reviews regardless, so this
 * only drives a UI badge. Single source of truth for the heuristic that
 * the /extract, bulk-analyse, and cron drainer paths all use.
 *
 * @param {object} f  extracted fields
 * @returns {'high'|'medium'}
 */
export function scoreExtractionConfidence(f) {
  const fields = f || {}
  const reconciles =
    Math.abs((Number(fields.subtotal) + Number(fields.tax_amount)) - Number(fields.total)) <= 0.01
  const allRequired =
    Boolean(fields.supplier_name) &&
    Boolean(fields.invoice_number) &&
    Boolean(fields.invoice_date) &&
    Number.isFinite(Number(fields.total))
  return allRequired && reconciles ? 'high' : 'medium'
}
