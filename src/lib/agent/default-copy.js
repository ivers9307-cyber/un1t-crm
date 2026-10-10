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
