// MIAHATCH.2 — Mia's tool blocks, and which one a turn gets.
//
// Five byte-stable cached blocks exist: `glofox` (the full list), `no_booking`
// (Glofox tools dropped, tool-capability.js), and the three un1t.online blocks
// built here from the same full list: `un1t_read` (a member at a un1t.online
// studio only: no booking writes), `un1t_read_dual` (the person is also
// answerable at a Glofox studio, so the Glofox booking tools stay) and
// `un1t_full` (MIAHATCH.5, block 3b: the dual block plus request_refund, with
// book_class and cancel_class_booking working at either studio; WhatsApp,
// writes_enabled and the studio's Mia switch only). Each is derived ONCE by the
// caller, so the prompt-cache prefix never moves between turns.
//
// Pure: tool lists come in as arguments, so this file imports no executor and
// the executors can import tool-capability.js without a cycle.

import {
  UN1T_WRITE_TOOL_NAMES, UN1T_PURCHASE_TOOL_NAMES, providerTakesBookings,
} from './tool-capability'

export { UN1T_WRITE_TOOL_NAMES, UN1T_PURCHASE_TOOL_NAMES }

// What a un1t.online READ block does not offer: the two booking writes, in 3a
// only (the dual block keeps them for the Glofox studio). The payment reminder
// is offered in both (MIAHATCH.3: it has a un1t.online source and a neutral
// description below).
const UN1T_READ_DROPPED = new Set(['book_class', 'cancel_class_booking'])

// Model-facing text, provider neutral (it is sent at a Glofox studio too, in
// the dual block). No em or en dashes; nothing that hints at how full a class
// is beyond the full flag: the words "limited", "spaces" and "capacity" never
// appear, and the model is told never to give a count.
export const UN1T_TOOL_DESCRIPTIONS = Object.freeze({
  get_my_membership:
    "Get the verified customer's current membership status (active, paused, cancelled) and their plan name. " +
    'When the plan is in the studio catalog, also a short description of what it includes, such as its pricing ' +
    'and commitment terms. Only works after verify_identity has succeeded this conversation. Use for ' +
    '"is my membership active", "what plan am I on", "what does my plan include". For an overdue payment ' +
    'or a payment reminder, use get_my_payment_reminder; for anything else about billing, hand off.',
  get_my_next_class:
    "Get the verified customer's next upcoming booked class (name and date/time). Only works after " +
    'verify_identity has succeeded this conversation. Use for "when is my next class", "what have I got booked".',
  list_my_upcoming_bookings:
    "List the VERIFIED member's own upcoming class bookings (class, day/time, booking id) straight from the " +
    'booking system. Use when a member asks what they are booked into. Only works after identity is verified.',
  get_my_recent_attendance:
    "Get a short summary of the verified customer's recent class attendance (how many classes attended in the " +
    'last 30 days, and when they last attended). Only works after verify_identity has succeeded. Use for ' +
    '"how many classes have I done", "when did I last come in".',
  get_my_payment_reminder:
    "Check whether the verified customer has a payment that is overdue at their studio, and since when and " +
    'for how much when known. Reports only whether a payment is overdue and never gives a pay link. Call this ' +
    'before answering anything about a payment reminder, a failed payment or "I\'ve paid". Only works after ' +
    'verify_identity has succeeded this conversation.',
  list_upcoming_classes:
    "List the studio's upcoming classes over the next few days (name and time) so a VERIFIED member can pick " +
    'one. Only works after verify_identity has succeeded this conversation. Use when a member asks ' +
    '"what classes are on", "can I book a class", "what\'s available tomorrow". Each class carries an event_id ' +
    'and a full flag, true or false. Never give a count, never say how many places are left and never hint that ' +
    'a class is nearly full. Offer an alternative to a full class.',
})

// The dual block's own text for the payment reminder: its answer has one section per
// studio, and only the un1t.online studio's is guaranteed to carry no pay link.
export const UN1T_DUAL_TOOL_DESCRIPTIONS = Object.freeze({
  get_my_payment_reminder:
    'Check whether the verified customer has a payment that is overdue. The answer has one section per studio. ' +
    "The un1t.online studio's section reports only whether a payment is overdue, and since when and for how much " +
    "when known, and never has a pay link. Another studio's section may say whether a reminder was sent and may " +
    'carry its own pay link. Call this before answering anything about a payment reminder, a failed payment or ' +
    '"I\'ve paid". Only works after verify_identity has succeeded this conversation.',
})

// list_upcoming_classes keeps its one optional parameter (the budget is
// tracked in tool-schemas.test.js); only its text is re-worded, dash free.
const UN1T_CLASS_LIST_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    days: {
      type: 'number',
      description:
        'How many days ahead to look, from 1 to 7. Default 7, the full visible week. NEVER ask the customer ' +
        'how far ahead to look; infer it from their request (a named day like "Friday" is always within 7).',
    },
  },
})

/**
 * The un1t.online READ block's tools, derived from the full list: the same
 * names in the same order, minus
 * book_class and cancel_class_booking unless `dual` (the person is also
 * answerable at a Glofox studio), with the six
 * read tools re-described in provider-neutral words. A re-described tool is a
 * new object; every other tool is the full list's own object. The input is
 * never touched. Pure.
 */
export function deriveUn1tReadTools(tools, { dual = false } = {}) {
  return tools
    .filter((t) => dual || !UN1T_READ_DROPPED.has(t.name))
    .map((t) => {
      const description = (dual && UN1T_DUAL_TOOL_DESCRIPTIONS[t.name]) || UN1T_TOOL_DESCRIPTIONS[t.name]
      if (!description) return t
      return t.name === 'list_upcoming_classes'
        ? { ...t, description, input_schema: UN1T_CLASS_LIST_SCHEMA }
        : { ...t, description }
    })
}

// MIAHATCH.5 — block 3b's own text for the two booking writes: they work at
// either studio (a "un1t:" id is the un1t.online studio's, any other id the
// Glofox studio's), so the Glofox wording ("24-hex Glofox event id") would be
// wrong. Same input schema shape as the full list (the same four and three
// properties, the same required one), so the optional-parameter budget does
// not move. No em or en dashes; never a word about how full a class is.
export const UN1T_FULL_TOOL_DESCRIPTIONS = Object.freeze({
  book_class:
    'Book the VERIFIED member into a class from list_upcoming_classes, at whichever studio the class is at. ' +
    'Before calling this, restate the exact class name and day and time back to the customer and get a clear yes; ' +
    'never book on an ambiguous message. Pass the event_id exactly as list_upcoming_classes gave it, plus the class ' +
    'name, time and starts_at you confirmed. Say the class is booked only when this tool\'s result says it is booked. ' +
    'If the result says the team will confirm, say exactly that; if it failed (class full, already booked, or anything ' +
    'else), relay that honestly and offer an alternative.',
  cancel_class_booking:
    "Cancel one of the VERIFIED member's upcoming bookings from list_my_upcoming_bookings, at whichever studio it is at. " +
    'Restate the exact class and day and time and get a clear yes before calling; never cancel on an ambiguous message. ' +
    "Say it is cancelled only when this tool's result says it is cancelled. If the system refuses (for example a late " +
    'cancellation, or a class that already happened), relay its reason honestly, and never promise a refund or a credit ' +
    'back. For a reschedule, confirm both the cancellation and the new class with the customer first, then cancel and ' +
    'book the new one.',
})

const UN1T_FULL_SCHEMA_TEXT = Object.freeze({
  book_class: {
    event_id: 'The event_id from list_upcoming_classes, copied exactly (a "un1t:" id or another studio\'s id).',
  },
  cancel_class_booking: {
    booking_id: 'The booking_id from list_my_upcoming_bookings, copied exactly (a "un1t:" id or another studio\'s id).',
  },
})

// A copy of the tool's input schema with some property descriptions replaced.
function reworded(schema, texts) {
  const properties = { ...schema.properties }
  for (const [prop, description] of Object.entries(texts)) {
    if (properties[prop]) properties[prop] = { ...properties[prop], description }
  }
  return { ...schema, properties }
}

// MIAHATCH.5 — a refund request goes to the team as a staff approval card
// (R2: never automatic, no code issues a refund). The executor arrives in a
// later task; the definition is fixed here so block 3b offers it. Neutral: it
// passes the request on and never says a refund will happen. One optional
// parameter (booking_id), counted in tool-schemas.test.js.
export const REQUEST_REFUND_TOOL = Object.freeze({
  name: 'request_refund',
  description:
    "Pass the VERIFIED member's refund request to the team. Use it when they ask for a refund or their money back " +
    'for anything (a class, a late cancellation, a payment). It does not refund anything: the team looks at the ' +
    'request and decides. After it succeeds, tell them you have passed it to the team and they will get back to ' +
    'them; never say a refund is done, approved or on its way, and never promise one. Only works after ' +
    'verify_identity has succeeded this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: "What the member wants refunded and why, briefly, in their words." },
      booking_id: {
        type: 'string',
        description: 'Only when the request is about one booking: its "un1t:" booking_id from list_my_upcoming_bookings, copied exactly.',
      },
    },
    required: ['reason'],
  },
})

/**
 * Block 3b's tools (MIAHATCH.5): the dual read block (every tool of the full
 * list, the reads re-described), with book_class and cancel_class_booking
 * re-described for either studio, then request_refund, then `extraTools`
 * (Task 19's purchase tools). A re-described tool is a new object; the input
 * is never touched. Pure.
 */
export function deriveUn1tFullTools(tools, { extraTools = [] } = {}) {
  const dual = deriveUn1tReadTools(tools, { dual: true }).map((t) => {
    const description = UN1T_FULL_TOOL_DESCRIPTIONS[t.name]
    if (!description) return t
    return { ...t, description, input_schema: reworded(t.input_schema, UN1T_FULL_SCHEMA_TEXT[t.name] || {}) }
  })
  return [...dual, REQUEST_REFUND_TOOL, ...extraTools]
}

/**
 * A cacheable copy of a tool list: the 1h cache breakpoint on the LAST tool
 * only (the whole block caches as one prefix). New last object; the others are
 * shared. MIA-HYGIENE.5 chose the 1h TTL. Pure.
 */
export function withCacheBreakpoint(tools) {
  return tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral', ttl: '1h' } }
      : tool,
  )
}

/**
 * Which tool block a turn gets: 'glofox' | 'no_booking' | 'un1t_read' |
 * 'un1t_read_dual' | 'un1t_full'.
 *
 * Today's rule (the thread's provider takes bookings: glofox, else no_booking)
 * holds for anything but a WhatsApp turn with a un1t.online studio answerable.
 * `answerable` is the MemberStudio[] this sender may be answered for
 * (member-studios.js). With a un1t.online studio answerable: `un1t_full` when
 * `un1tWrites` (turn-studios.js decides it: writes_enabled and the studio's
 * Mia switch, Ruling 25), else `un1t_read_dual` when a
 * Glofox studio is answerable too, else `un1t_read`. Every answerable studio on
 * Glofox is `glofox`; a studio with no provider is neither, so it stays on
 * today's rule. Pure.
 */
export function selectToolBlock({ answerable, threadProvider, channel, un1tWrites } = {}) {
  const today = providerTakesBookings(threadProvider) ? 'glofox' : 'no_booking'
  if (channel !== 'whatsapp') return today
  const studios = Array.isArray(answerable) ? answerable : []
  if (studios.length === 0) return today
  const hasUn1t = studios.some((s) => s?.providerKey === 'un1t_online')
  const hasGlofox = studios.some((s) => s?.providerKey === 'glofox')
  if (hasUn1t) {
    if (un1tWrites === true) return 'un1t_full'
    return hasGlofox ? 'un1t_read_dual' : 'un1t_read'
  }
  return hasGlofox && studios.every((s) => s?.providerKey === 'glofox') ? 'glofox' : today
}
