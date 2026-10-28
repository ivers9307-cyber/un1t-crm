// BOOKCHATCOPY.1 (C111) — the line the staff Book panel drops into an open
// WhatsApp/Instagram thread after booking a consultation or a Glofox class.
// It is customer copy, so it is operator-editable and plain (no em-dashes, no
// emoji; low-key). It was hard-coded as "✅ Booked into X — time".
//
// The text is the studio's booking confirmation message,
// settings.customer_agent.booking_confirmation_text: the field Mia's approved
// bookings already send (src/lib/agent/notify.js), edited on the customer
// agent settings page. One setting, so a customer reads the same words
// whether Mia or a person booked them. Blank = DEFAULT_BOOK_CHAT_TEXT, which
// equals Mia's default (pinned by book-chat-copy.test.js).
//
// {class} becomes what was booked ("HIIT, Tue 3 Oct 18:30"); with nothing to
// say the "for {class}" clause is dropped, as notify.js does.
//
// No static imports: BookPanel (a client component) renders the text, and the
// booking routes read the template with readBookChatTemplate, which loads the
// (server-side) settings resolver lazily so the panel's bundle never carries it.

export const DEFAULT_BOOK_CHAT_TEXT = "Good news, you're booked in for {class}. See you there."

// Same mapping as stripEmDashes in src/lib/agent/core.js (server-only there).
function plain(s) {
  return String(s ?? '')
    .replace(/\s*[—–]\s+/g, ', ')
    .replace(/\s+[—–]\s*/g, ', ')
    .replace(/[—–]/g, '-')
}

/**
 * @param {{ what?: string, template?: string|null }} args
 * @returns {string}
 */
export function bookChatConfirmationText({ what, template } = {}) {
  const base = String(template || '').trim() || DEFAULT_BOOK_CHAT_TEXT
  const booked = String(what || '').trim()
  const filled = booked
    ? base.replace(/\{class\}/g, booked)
    : base.replace(/\s*\bfor\s+\{class\}/gi, '').replace(/\s*\{class\}/g, '')
  return plain(filled).trim()
}

// UN1TMOVE.2 — "your booking was moved", the staff Move's chat line: the
// studio's settings.customer_agent.class_move_confirmation_text (the field
// Mia's approved move cards send too), with the same default as
// DEFAULT_CLASS_MOVE_CONFIRMATION_TEXT in src/lib/agent/notify.js (pinned by
// book-chat-copy.move.test.js). {from} / {to}: each class with its day and time.
export const DEFAULT_MOVE_CHAT_TEXT = 'All sorted, your booking has been moved from {from} to {to}. See you there.'

/**
 * @param {{ from?: string, to?: string, template?: string|null }} args
 * @returns {string}
 */
export function moveChatConfirmationText({ from, to, template } = {}) {
  const base = String(template || '').trim() || DEFAULT_MOVE_CHAT_TEXT
  const f = String(from || '').trim()
  const t = String(to || '').trim()
  let out = base
  out = f ? out.replace(/\{from\}/g, f) : out.replace(/\s*\bfrom\s+\{from\}/gi, '').replace(/\s*\{from\}/g, '')
  out = t ? out.replace(/\{to\}/g, t) : out.replace(/\s*\bto\s+\{to\}/gi, '').replace(/\s*\{to\}/g, '')
  return plain(out).trim()
}

/**
 * The studio's operator-set booking confirmation text, for a booking route to
 * hand the panel. { template: null, error: null } = unset (the default
 * applies). A failed read is reported as `error`, never as "unset": the route
 * logs it and the panel still sends the default, because the customer is
 * booked and a confirmation in the default words beats none.
 *
 * @returns {Promise<{ template: string|null, error: string|null }>}
 */
export async function readBookChatTemplate(db, locationId) {
  return readChatTemplate(db, locationId, 'booking_confirmation_text')
}

/** UN1TMOVE.2 — as readBookChatTemplate, for the class move confirmation. */
export async function readMoveChatTemplate(db, locationId) {
  return readChatTemplate(db, locationId, 'class_move_confirmation_text')
}

async function readChatTemplate(db, locationId, key) {
  if (!locationId) return { template: null, error: null }
  try {
    // MIAORG.1 — the studio's resolved Mia settings (DEFAULTS <- org <-
    // studio), so an org-wide confirmation text reaches the panel too. The
    // resolver logs the underlying read error; a failed read is reported here
    // as `read_failed`, never as "unset".
    const { resolveAgentSettings } = await import('./agent/settings-resolve')
    const resolved = await resolveAgentSettings(db, locationId)
    if (!resolved.ok) return { template: null, error: resolved.reason === 'read_failed' ? 'read_failed' : null }
    const text = String(resolved.settings[key] || '').trim()
    return { template: text || null, error: null }
  } catch (e) {
    return { template: null, error: e?.message || String(e) }
  }
}
