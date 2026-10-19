// W1.S3 — Mia's two code-default customer texts, as functions of the brand.
//
// Pure and dependency-free on purpose: the settings editor
// (src/app/settings/customer-agent/CustomerAgentClient.jsx, a client
// component) renders these as its placeholders, and importing core.js or
// welcome-greeting.js there would ship the system prompt / the WhatsApp send
// code to the browser. The brand is the location's resolved companyName
// (getLocationBranding, src/lib/location-branding.js), so a second gym's
// customers never read another gym's wordmark; with no brand the sentence
// still reads naturally. The operator-editable settings fields
// (holding_message, welcome_greeting) override both.
//
// Customer copy rules (Richard): no em dashes, no emoji, low-key tone.

/** The hand-off acknowledgement sent when Mia passes a thread to a human. */
export function defaultHoldingMessage(brand) {
  const b = String(brand || '').trim()
  return `Thanks for your message! One of the ${b ? `${b} ` : ''}team will get back to you shortly.`
}

/**
 * The instant greeting on a request_welcome thread (click-to-WhatsApp ad).
 * Names the agent when the studio set one (settings.customer_agent.agent_name).
 */
export function defaultWelcomeGreeting({ agentName, brand } = {}) {
  const name = String(agentName || '').trim()
  const b = String(brand || '').trim()
  const who = name ? `I'm ${name}, the studio's assistant` : "I'm the studio's assistant"
  const where = b ? ` at ${b}` : ''
  return `Hi, ${who}${where}. Ask me anything, or tell me if you'd like to book a free class or a consultation.`
}

/**
 * MIAORG.1 Task 5 — the button on Mia's message carrying the studio's booking
 * link (settings.customer_agent.booking_url) at a studio Mia cannot book for.
 * The operator's booking_cta_label overrides it.
 */
export const DEFAULT_BOOKING_CTA_LABEL = 'Book a class'

/**
 * MIAHATCH.2 — what Mia says when a member asks her to book or cancel a class
 * at a un1t.online studio (Hatch Street), where chat booking is not live yet.
 * `{studio}` is that studio's name, `{link}` its booking link
 * (settings.customer_agent.booking_url); the second text is used when the
 * studio has no link. The operator's chat_booking_unavailable_text overrides
 * them (renderMiaCopy, mia-copy.js).
 */
export const DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT = "I can't book classes at {studio} from here just yet. You can book here: {link}"
export const DEFAULT_CHAT_BOOKING_UNAVAILABLE_NO_LINK_TEXT = "I can't book classes at {studio} from here just yet. The team will help you book."

/**
 * MIAHATCH.4 (spec 6.6) — what Mia and the pay pages say at a un1t.online
 * studio (Hatch Street) about buying a pack or membership and being booked
 * after paying. `{product}` is what is being bought, `{class}` the class the
 * customer asked for (purchase_link_text has a second text for when there is
 * none). The operator's value for the same-named settings key overrides each
 * (renderMiaCopy, mia-copy.js); none of these may contain an em or en dash.
 */
export const DEFAULT_PURCHASE_OFFER_INTRO_TEXT = "You've used all your classes. Here's how to keep training with us:"
export const DEFAULT_PURCHASE_LINK_TEXT = "Here's your secure payment link for {product}. Once it goes through I'll book you into {class}."
export const DEFAULT_PURCHASE_LINK_NO_CLASS_TEXT = "Here's your secure payment link for {product}. I'll let you know when it's done."
export const DEFAULT_TRIAL_USED_TEXT = "It looks like you've had your free trial with us before, so here are the ways to keep training:"
export const DEFAULT_REFUND_REQUEST_TEXT = "I've passed that to the team, they'll look at it and get back to you."
export const DEFAULT_PURCHASE_LINK_OPEN_TEXT = "You already have a payment link waiting for {product}. Use that one, or I can ask the team if you'd like something different."
export const DEFAULT_PURCHASE_PAID_BOOKED_TEXT = "Payment received, thank you! You're booked into {class}. See you there."
export const DEFAULT_PURCHASE_PAID_CLASS_GONE_TEXT = "Payment received, thank you! {class} is no longer available, so I haven't booked it. Reply here and I'll find you another class."
export const DEFAULT_PURCHASE_PAID_BOOKING_FAILED_TEXT = "Payment received, thank you! I couldn't book {class} just now, so the team will sort it and confirm with you shortly."
export const DEFAULT_PURCHASE_PAID_NO_CLASS_TEXT = "Payment received, thank you! It's on your account now. Would you like me to book you a class?"
export const DEFAULT_PAY_DONE_PAGE_TEXT = 'Thanks! You can go back to WhatsApp now.'
export const DEFAULT_PAY_CANCEL_PAGE_TEXT = 'No problem, nothing was charged. You can go back to WhatsApp.'
