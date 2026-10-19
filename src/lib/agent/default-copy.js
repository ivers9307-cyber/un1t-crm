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
 * FLOWACK.1 — the one reply to a completed WhatsApp booking Flow (a class
 * request), sent instead of a Mia turn. It must never claim the class is
 * booked: the booking is processed afterwards and its real outcome follows
 * (whatsapp-flow/booking-notice.js). The operator's flow_booking_ack_text
 * overrides it.
 */
export const DEFAULT_FLOW_BOOKING_ACK_TEXT = "Got it, we're booking your spot now. You'll get a confirmation shortly."

/**
 * FLOWACK.1 — sent on the thread when a Flow booking could not be completed
 * automatically and went to the team (a staff card). The operator's
 * flow_booking_holding_text overrides it.
 */
export const DEFAULT_FLOW_BOOKING_HOLDING_TEXT = 'Thanks, the team is confirming your class and will be in touch shortly.'

/**
 * FLOWACK.1 review — the reply to a Flow submission for a class this customer
 * has already asked for (the queue's one-request-per-class index refused a
 * second row). Not "we're booking your spot": nothing new is booked. The
 * confirmation of the original request still follows (the class_confirmed
 * template, the Flow outcome notice or the un1t.online email), so it does not
 * promise it "here". A duplicate of a class already BOOKED gets the booking
 * confirmation instead. The operator's flow_booking_duplicate_text overrides it.
 */
export const DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT = "You've already asked for that class. You'll get a confirmation shortly."

