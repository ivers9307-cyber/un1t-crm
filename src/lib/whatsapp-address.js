// WA-BSUID.2 — who an inbound WhatsApp message is from, and how to address a
// reply, now that Meta can leave the phone number out.
//
// A WhatsApp user with a username can hide their number. Meta then omits
// `messages[].from` and `contacts[].wa_id` from the webhook and identifies the
// sender by a business-scoped user id (BSUID) only: `messages[].from_user_id`
// and `contacts[].user_id`. A message to such a person is sent with
// `recipient: <BSUID>` in place of `to: <phone>`.
//
// The webhook used to read `message.from` and call `.startsWith` on it, so a
// phone-less message threw, was lost (its dedupe key was already claimed) and
// took the rest of that webhook POST with it. These helpers are the one place
// that decides "phone or BSUID", so every caller that hands an address to a
// send function can keep passing a single string.
//
// A BSUID is "the user's ISO 3166 alpha-2 country code and a period, followed
// by up to 128 alphanumeric characters" (US.13491208655302741918); a parent
// BSUID carries ENT after the period (US.ENT.118…). A phone number is digits
// with an optional leading +, so the two can never be confused.

const BSUID_SHAPE = /^[A-Za-z]{2}\.\S+$/

function clean(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** True when `value` is a business-scoped user id rather than a phone number. */
export function isBsuid(value) {
  return typeof value === 'string' && BSUID_SHAPE.test(value.trim())
}

/**
 * The addressing fields of a Cloud API send body: `{ recipient }` for a BSUID,
 * `{ to }` for a phone number. Spread it into the payload.
 */
export function recipientFields(address) {
  return isBsuid(address) ? { recipient: String(address).trim() } : { to: address }
}

/**
 * Who sent an inbound message.
 *   phone   — `messages[].from`, or null when Meta withheld it
 *   bsuid   — `messages[].from_user_id`, else the matching `contacts[].user_id`
 *   name    — the WhatsApp profile name of the matching `contacts[]` entry
 *   address — what a reply is sent to: the phone when there is one, else the BSUID
 *
 * @param {object} message              one entry of change.value.messages
 * @param {Array|undefined} contacts    change.value.contacts
 * @returns {{ phone: string|null, bsuid: string|null, name: string|null, address: string|null }}
 */
export function inboundSender(message, contacts) {
  const list = Array.isArray(contacts) ? contacts.filter(Boolean) : []
  const phone = clean(message?.from)
  const fromUserId = clean(message?.from_user_id)

  const matched = (phone && list.find((c) => c.wa_id === phone))
    || (fromUserId && list.find((c) => c.user_id === fromUserId))
    || null
  // With no explicit match, a lone contacts[] entry still names the sender
  // (the array carries one entry per message in practice). With several
  // entries and no match, nobody is guessed: a message filed in the wrong
  // person's thread is worse than one reported as unattributable.
  const bsuid = fromUserId || clean((matched || (list.length === 1 ? list[0] : null))?.user_id)

  return {
    phone,
    bsuid,
    name: clean(matched?.profile?.name),
    address: phone || bsuid || null,
  }
}

/**
 * What to send a reply in a stored thread to: the contact's WhatsApp number,
 * else the thread's own number, else the thread's BSUID (a person who has only
 * ever written to us with their number hidden).
 */
export function conversationAddress(conversation, contact = null) {
  return clean(contact?.wa_phone) || clean(conversation?.wa_phone) || clean(conversation?.wa_bsuid) || null
}
