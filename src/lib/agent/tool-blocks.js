// MIAHATCH.2 — Mia's tool blocks, and which one a turn gets.
//
// Four byte-stable cached blocks exist (a fifth, un1t_full, arrives with the
// un1t.online write tools): `glofox` (the full list), `no_booking` (Glofox
// tools dropped, tool-capability.js), and the two un1t.online READ blocks built
// here from the same full list: `un1t_read` (a member at a un1t.online studio
// only: no booking writes) and `un1t_read_dual` (the person is also answerable
// at a Glofox studio, so the Glofox booking tools stay). Each is derived ONCE
// by the caller, so the prompt-cache prefix never moves between turns.
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
    '"is my membership active", "what plan am I on", "what does my plan include". For live billing standing ' +
    'or payment issues, hand off.',
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
      const description = UN1T_TOOL_DESCRIPTIONS[t.name]
      if (!description) return t
      return t.name === 'list_upcoming_classes'
        ? { ...t, description, input_schema: UN1T_CLASS_LIST_SCHEMA }
        : { ...t, description }
    })
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
 * `un1tWrites` (false until the write tools ship), else `un1t_read_dual` when a
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
