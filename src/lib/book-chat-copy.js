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
// No imports: BookPanel (a client component) renders the text, and the booking
// routes read the template with readBookChatTemplate.

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
  if (!locationId) return { template: null, error: null }
  try {
    const { data, error } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    if (error) return { template: null, error: error.message || String(error) }
    const text = String(data?.settings?.customer_agent?.booking_confirmation_text || '').trim()
    return { template: text || null, error: null }
  } catch (e) {
    return { template: null, error: e?.message || String(e) }
  }
}
