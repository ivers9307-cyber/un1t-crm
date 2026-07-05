// src/lib/recon/hunt-scoring.js
//
// RCOV.P1 — ask Claude whether one email attachment is THE invoice
// explaining one bank line. Mirrors invoice-extraction.js's Anthropic
// call conventions (model, headers, envelopes, fence-strip + zod).
// The final match decision is a separate pure function so thresholds
// are unit-testable without any network mock.
//
// stripJsonFences: invoice-extraction.js's copy is NOT exported (it's
// a private helper there), so this file carries its own local copy
// rather than modifying that file.
import { z } from 'zod'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-4-6'
// claude-sonnet-4-6 pricing per 1M tokens
const INPUT_USD_PER_TOKEN = 3 / 1_000_000
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000

export const huntVerdict = z.object({
  is_match: z.boolean(),
  confidence: z.coerce.number().min(0).max(1),
  supplier_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  total: z.coerce.number().nullable(),
  invoice_date: z.string().nullable(),
  reason: z.string().max(300),
})

const SYSTEM_PROMPT = `You are verifying whether an attached document is the invoice or receipt that explains one specific bank transaction.

You will be given the bank transaction's date, signed amount (negative = money out), and the bank statement description. Judge:
- supplier match: does the document's issuer plausibly match the statement description?
- amount match: does the document's GROSS total equal the transaction amount (absolute value)?
- date proximity: is the document dated within a sensible window of the transaction?

Be strict: if the document is a statement, reminder, quote, or order confirmation rather than an invoice/receipt, or the totals don't correspond, it is NOT a match.

Return ONLY a JSON object: {"is_match": boolean, "confidence": number 0-1, "supplier_name": string|null, "invoice_number": string|null, "total": number|null (gross total on the document), "invoice_date": "YYYY-MM-DD"|null, "reason": string (max 300 chars)}. No markdown fences, no prose.`

function stripJsonFences(raw) {
  return String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
}

function contentBlockFor(bytes, mime) {
  const data = Buffer.from(bytes).toString('base64')
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  }
  return { type: 'image', source: { type: 'base64', media_type: mime, data } }
}

export async function scoreHuntCandidate({ bytes, mime, line }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY is not configured.' }

  const userText =
    `Bank transaction — date: ${line.line_date}; amount: ${line.amount} EUR (negative = money out); ` +
    `statement description: ${line.description || '(none)'}; reference: ${line.reference || '(none)'}. ` +
    `Is the attached document the invoice/receipt for this exact transaction? Return only the JSON verdict.`

  let res
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [contentBlockFor(bytes, mime), { type: 'text', text: userText }] }],
      }),
    })
  } catch (e) {
    return { ok: false, error: `Anthropic API request failed: ${e.message || String(e)}` }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>')
    return { ok: false, error: `Anthropic API error (${res.status}): ${errText}` }
  }
  const data = await res.json().catch(() => null)
  if (!data) return { ok: false, error: 'Anthropic returned non-JSON response body.' }

  const spendUsd =
    (data.usage?.input_tokens || 0) * INPUT_USD_PER_TOKEN +
    (data.usage?.output_tokens || 0) * OUTPUT_USD_PER_TOKEN

  const raw = (data.content || []).find((b) => b.type === 'text')?.text || ''
  if (!raw) return { ok: false, error: 'Anthropic response contained no text block.', spendUsd }

  let parsed
  try {
    parsed = JSON.parse(stripJsonFences(raw))
  } catch (e) {
    return { ok: false, error: `Failed to parse verdict JSON: ${e.message}`, raw_response: raw, spendUsd }
  }
  const validation = huntVerdict.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      error: `Verdict failed schema validation: ${validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      raw_response: raw,
      spendUsd,
    }
  }
  return { ok: true, verdict: validation.data, spendUsd }
}

// Pure decision — thresholds live HERE, not in prompts. Precision over
// recall: require the model's own is_match AND >=0.8 confidence AND
// the document total corroborating the bank amount (2c absolute or 2%
// relative tolerance).
export function isHuntMatch(verdict, line) {
  if (!verdict?.is_match) return false
  if (!(verdict.confidence >= 0.8)) return false
  if (verdict.total == null) return false
  const want = Math.abs(Number(line.amount))
  const got = Math.abs(Number(verdict.total))
  const absDiff = Math.abs(want - got)
  return absDiff <= 0.02 || (want > 0 && absDiff / want <= 0.02)
}
