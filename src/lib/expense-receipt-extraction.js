// FTE-EXPENSES.3 — Claude Vision receipt OCR.
//
// Sibling of src/lib/invoice-extraction.js but tuned for the smaller,
// simpler shape of an expense receipt. Two key differences:
//
//   1. Receipt photos are the dominant input (vs PDFs for contractor
//      invoices). The schema doesn't have line items — every receipt
//      is treated as one line on the claim.
//   2. The output is the EXACT shape that fte_expense_items expects:
//      expense_date, vendor, amount, vat_amount, category-suggestion
//      and a one-line description. The route just maps it into the
//      add-item form pre-fill on the client; nothing is persisted
//      until the operator confirms.
//
// The OCR runs synchronously in the API route (15-25s typical for a
// phone photo) and returns the pre-fill payload. The client uses it
// to seed the add-item form; the operator reviews + adjusts +
// commits via the existing POST /api/expenses/[id]/items multipart
// upload. Splitting OCR from save means the operator never loses
// the file if Claude returns garbage — the upload of record happens
// only after confirmation.

import { z } from 'zod'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-4-6'

const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  // iPhone camera roll sometimes serves HEIC. Claude Vision accepts
  // PNG/JPEG/GIF/WebP; HEIC needs a conversion step we don't have
  // yet, so reject it with a useful message. Track follow-up.
])

// The shape we want Claude to return. Tighter than invoiceFields
// because receipts don't have line items — every receipt is a single
// expense. category is suggested by Claude based on vendor + items
// purchased; the operator can override in the UI.
export const receiptFieldsSchema = z.object({
  // ISO YYYY-MM-DD. Claude is told to convert any visible date.
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expense_date must be YYYY-MM-DD'),
  // Merchant / vendor name from the receipt header.
  vendor: z.string().min(1).max(200).nullable().optional(),
  // Total amount inclusive of VAT — the bottom-line "TOTAL" on the
  // receipt. coerce in case Claude returns "12.50" as a string.
  amount: z.coerce.number().positive(),
  // VAT portion. If the receipt doesn't break it out, Claude returns
  // 0 — operator can correct.
  vat_amount: z.coerce.number().min(0),
  // Suggested category, mapped to our enum. Claude is told to pick
  // the best fit; if it can't, it returns "other".
  category: z.enum(['travel', 'meals', 'supplies', 'mileage', 'training', 'other']),
  // Short human-readable description Claude infers from the items
  // bought. The operator typically keeps this verbatim or trims it.
  description: z.string().max(500).nullable().optional(),
  // Confidence — Claude returns 'high' for clean receipts, 'medium'
  // for partially obscured, 'low' for crumpled / handwritten /
  // unfamiliar formats. The UI uses this to flag "double-check".
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

const SYSTEM_PROMPT = `You are an expense receipt data extractor. The user will attach a single receipt photo or PDF. Extract the fields below into a JSON object and return ONLY the JSON — no prose, no markdown code fences, no commentary.

Required fields:
- expense_date (string) — ISO format YYYY-MM-DD. The date printed on the receipt. If only a year+month is visible, use the 1st of the month.
- vendor (string | null) — merchant / shop name as shown on the receipt header. Null if illegible.
- amount (number) — the bottom-line TOTAL on the receipt, inclusive of any VAT or tax. Strip currency symbols, commas, and any other formatting.
- vat_amount (number) — the VAT / tax portion of the total. If the receipt doesn't break it out, return 0.
- category (string) — pick the best fit from this fixed list:
  - "travel" — trains, taxis, flights, fuel, accommodation, transit cards
  - "meals" — restaurants, cafes, catering, customer entertainment
  - "supplies" — office supplies, hardware, cleaning, gym consumables
  - "mileage" — petrol receipts when claimed for kilometres travelled
  - "training" — courses, books, conference registrations, certifications
  - "other" — anything that genuinely doesn't fit the above
- description (string | null) — one short line summarising what was purchased (e.g. "Dublin → Cork return ticket" or "Office printer paper x3"). Maximum 200 characters.
- confidence (string) — your read on how clean the extraction is:
  - "high" — clear receipt, all fields confidently extracted
  - "medium" — most fields clear, one or two inferred from context
  - "low" — receipt is partially illegible / handwritten / unfamiliar format

Rules:
- Numbers must be JSON numbers, not strings. Strip € £ $ symbols, commas, decimal separators that aren't periods.
- Dates must be ISO format. If the receipt shows "12/03/2026" treat as DD/MM/YYYY (Irish / UK convention) and convert to "2026-03-12".
- For category, NEVER invent a new value — pick exactly one of the six listed strings.
- If you cannot confidently determine the amount, set confidence to "low" but still return your best guess.
- Return ONLY the JSON object, starting with { and ending with }. No markdown fences. No preamble.`

/**
 * Extract receipt fields from a buffer of bytes. The route handler
 * gets the file via multipart, hands the raw buffer + MIME type here,
 * and we send it straight to Claude. No DB or Storage interaction —
 * keeps this lib pure / unit-testable independently of the schema.
 *
 * Returns { ok: true, fields, raw_response } on success or
 * { ok: false, error, raw_response? } on failure. Never throws.
 *
 * @param {Buffer | Uint8Array} bytes The receipt file bytes.
 * @param {string} mimeType MIME type of the file.
 */
export async function extractReceiptFields(bytes, mimeType) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY is not configured.' }
  }
  if (!bytes || !bytes.length) {
    return { ok: false, error: 'No receipt bytes provided.' }
  }
  if (!SUPPORTED_MIME.has(mimeType)) {
    return {
      ok: false,
      error: `Unsupported MIME type for OCR: ${mimeType || '(missing)'}. Supported: PDF, JPEG, PNG, GIF, WebP. HEIC photos need conversion first — open and re-save from Photos as JPEG.`,
    }
  }

  const base64 = Buffer.from(bytes).toString('base64')
  const isPdf = mimeType === 'application/pdf'
  const documentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType, data: base64 } }

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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            documentBlock,
            { type: 'text', text: 'Extract the receipt fields per your system instructions. Return only the JSON object.' },
          ],
        }],
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
  try { parsed = JSON.parse(stripJsonFences(raw)) }
  catch (e) {
    return { ok: false, error: `Failed to parse extracted JSON: ${e.message}`, raw_response: raw }
  }

  // Clamp VAT to amount before validation — Claude sometimes returns
  // a VAT figure larger than the amount when reading a multi-item
  // receipt where only a subtotal is visible. The DB CHECK on the
  // items table would reject it; clamp here so the pre-fill is
  // sane and the operator just sees the smaller number.
  if (typeof parsed.amount === 'number' && typeof parsed.vat_amount === 'number') {
    if (parsed.vat_amount > parsed.amount) parsed.vat_amount = parsed.amount
  }

  const validation = receiptFieldsSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      error: `Extracted JSON failed schema validation: ${validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      raw_response: raw,
    }
  }
  return { ok: true, fields: validation.data, raw_response: raw }
}

function stripJsonFences(raw) {
  let s = (raw || '').trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  return s
}
