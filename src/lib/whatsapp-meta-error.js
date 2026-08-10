// Meta Graph API errors keep their diagnosis in error_user_title / error_user_msg,
// NOT in `message`. On the template-submission endpoints `message` is the literal
// string "Invalid parameter" for a dozen unrelated causes (bad buttons, duplicate
// name, missing variable example, ...), so throwing `message` alone hands the
// operator a dead end. Live 2026-08-10: a template submit failed with code 100 /
// subcode 2388060, and the only actionable sentence — "Buttons can't have any
// variables, newlines, emojis or formatting characters." — was discarded on the
// way to the UI.

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Flatten a Meta error object into one operator-readable line.
 * Prefers Meta's user-facing copy, falls back to the generic message plus
 * error_data.details, and always keeps the code/subcode for lookup.
 */
export function formatMetaError(error, fallback = 'WhatsApp API error') {
  if (!error || typeof error !== 'object') return fallback

  const title = clean(error.error_user_title)
  const userMsg = clean(error.error_user_msg)
  const details = clean(error.error_data?.details)
  const generic = clean(error.message)

  // User-facing copy wins outright — "Invalid parameter" adds nothing beside it.
  const headline = title || userMsg
    ? [title, userMsg || details].filter(Boolean).join(' — ')
    : [generic || fallback, details].filter(Boolean).join(' — ')

  const codes = [error.code, error.error_subcode]
    .filter((c) => typeof c === 'number' || (typeof c === 'string' && c.trim()))
    .join('/')

  return codes ? `${headline} (Meta ${codes})` : headline
}
