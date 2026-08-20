// EMPTY-STRING-FIELDS.1 — turn a standard API error envelope into a sentence
// an operator can act on.
//
// Every route in this repo answers a schema failure with the shape
// `{ success: false, error: 'Invalid request body', issues: [{ path, message }] }`
// (see validateBody in src/lib/validate.js). The `error` half is a constant —
// it names the CATEGORY of failure and nothing about the cause — while the
// `issues` half carries the field and the reason. UI that renders only `error`
// therefore shows "Invalid request body" no matter what is actually wrong.
//
// That is not a hypothetical: a Tesco receipt whose date box was empty failed
// on `invoice_date must be YYYY-MM-DD`, and the operator was shown "Invalid
// request body" against a receipt that looked entirely fine, with no way to
// tell which of a dozen boxes the route objected to.
//
// Kept deliberately dumb — formatting only, no fetch, no React — so any
// surface (inbox, mobile, a future admin screen) can use it.

// Does `message` already refer to `path` as a whole word? Dotted paths
// ("line_items.0.description") are judged on their last named segment, which
// is what a zod message would use.
function namesField(message, path) {
  const leaf = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() || path
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i').test(message)
}

/**
 * Build a human-readable message from an API error envelope.
 *
 * @param {{ error?: string, issues?: Array<{path?: string, message?: string}> }|null} body
 *        Parsed JSON response body.
 * @param {string} [fallback='Request failed']  Used when the body names nothing.
 * @returns {string}
 */
export function describeApiError(body, fallback = 'Request failed') {
  const base = (body && typeof body.error === 'string' && body.error.trim()) || fallback
  const issues = Array.isArray(body?.issues) ? body.issues : []

  const detail = issues
    .map((i) => {
      const path = typeof i?.path === 'string' ? i.path.trim() : ''
      const message = typeof i?.message === 'string' ? i.message.trim() : ''
      if (!message) return path || null
      // A zod message often already names the field ("invoice_date must be
      // YYYY-MM-DD"); prefixing the path again would read as a stutter. Match
      // on a WORD BOUNDARY, not a substring — `total` is a substring of
      // "Subtotal required", and suppressing the prefix there would drop the
      // only thing telling the operator which field to look at.
      if (!path || namesField(message, path)) return message
      return `${path}: ${message}`
    })
    .filter(Boolean)

  if (!detail.length) return base
  // Cap it: a whole-object failure can produce a dozen issues, and a wall of
  // text in a toast is as unreadable as no detail at all.
  const shown = detail.slice(0, 3).join('; ')
  const rest = detail.length - 3
  return `${base} — ${shown}${rest > 0 ? ` (+${rest} more)` : ''}`
}
