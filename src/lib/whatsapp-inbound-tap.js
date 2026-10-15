// WABUTTONTAP.1 — what a customer's tap on a WhatsApp button stores as the
// message body. Two shapes reach the webhook:
//
//   - type 'button': a quick-reply button on a TEMPLATE (the Meta-ad welcome's
//     "consultation vs first class"). Meta sends { button: { text, payload } };
//     payload is whatever the send set, or the button text when it set none.
//   - type 'interactive' (button_reply / list_reply): a button or list row on
//     a session interactive message (Mia's [[OPTIONS]]). Meta sends
//     { id, title }.
//
// whatsapp_messages has no metadata column, so the machine value (payload /
// id) is kept in the body, the way location and shared-contact messages keep
// theirs, but only when it says something the visible text does not: a
// payload equal to the text, or one of Mia's own `opt_<n>` ids, adds nothing
// and would only clutter the inbox and Mia's history. Pure.

// Mia's interactive option ids (buildInteractivePayload in whatsapp.js).
export function agentOptionId(index) {
  return `opt_${index}`
}

const AGENT_OPTION_ID = /^opt_\d+$/

function clean(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function withValue(text, value, label) {
  if (!text) return value
  if (!value || value === text) return text
  return `${text} (${label}: ${value})`
}

/** Body for a type 'button' message (a template quick-reply tap). */
export function buttonTapBody(button) {
  return withValue(clean(button?.text), clean(button?.payload), 'button payload')
}

/** Body for an interactive button_reply / list_reply. */
export function interactiveReplyBody(interactive) {
  const reply = interactive?.button_reply || interactive?.list_reply
  const title = clean(reply?.title)
  const id = clean(reply?.id)
  return withValue(title, AGENT_OPTION_ID.test(id) ? '' : id, 'option id')
}
