// MIAORG.1 Task 5 — Mia's tool set follows the THREAD's studio.
//
// A studio whose membership source cannot take bookings (un1t.online at Hatch
// Street, or no source at all: every capability false, src/lib/membership/
// sources/*) gets a smaller tool block: nothing that reads or writes Glofox,
// or reads the Glofox-synced columns on contacts, and nothing whose APPROVAL
// runs a Glofox action. The studio is the one the turn is answered AT (the
// conversation's location_id, which is what the runner's locationId is),
// never the contact's home studio: a Hatch thread bound to a Stillorgan
// contact must not report Stillorgan's membership as Hatch's.
//
// Two layers, on purpose. The model is never OFFERED these tools at such a
// studio (the no-booking tool block, built once from the full one), and the
// executor REFUSES them if the model names one anyway: Sonnet 5 has invented
// tool names before, and a tool missing from the list is not a tool it cannot
// call.
//
// Pure and dependency-free so the eval harness and tests can load it.

/**
 * Tools dropped (and refused) at a studio whose provider has
 * `capabilities.bookings === false`. Each reads Glofox or Glofox-synced
 * data, writes Glofox, or files a card whose approval can execute in Glofox.
 */
export const BOOKING_SYSTEM_TOOL_NAMES = Object.freeze(new Set([
  // Glofox-synced reads off the contact row (membership state, plan, payment
  // reminder standing, recent_bookings, attendance rollups).
  'get_my_membership',
  'get_my_payment_reminder',
  'get_my_next_class',
  'get_my_recent_attendance',
  // CANCEL-FORM.5: approving a cancellation executes it in Glofox when the
  // row's studio opted in (glofox_auto_cancel_memberships).
  'request_cancellation',
  // Glofox writes and reads; book_class's approval card books in Glofox and
  // can buy a trial membership first (grantTrialBeforeBooking).
  'book_class',
  'list_my_upcoming_bookings',
  'cancel_class_booking',
]))

/** The timetable tool's description at a studio without a booking system. */
export const NO_BOOKING_CLASS_LIST_DESCRIPTION =
  "List the studio's upcoming classes over the next two weeks (class name and start time " +
  'only). No identity verification needed. Use when someone asks "what classes are on", ' +
  '"is there a class tomorrow morning". You cannot book or cancel classes at this studio, ' +
  'and the list never says whether a class is full or has spaces, so never say either. ' +
  'If the result has truncated: true, the list stops before the end of the two weeks (it holds ' +
  'only the earliest classes), so never say a later day has nothing on; say you can only see ' +
  'the nearer dates and offer the booking link or the team for later ones.'

/** Does this provider take bookings? Anything but an explicit true is no. */
export function providerTakesBookings(provider) {
  return provider?.capabilities?.bookings === true
}

/**
 * The no-booking tool list, derived from the full one: the booking-system
 * tools removed, and list_upcoming_classes re-described (a new object; the
 * full list's objects are never touched). Order is kept, so the last tool is
 * the same tool in both lists. Pure.
 */
export function deriveNoBookingTools(tools) {
  return tools
    .filter((t) => !BOOKING_SYSTEM_TOOL_NAMES.has(t.name))
    .map((t) => (t.name === 'list_upcoming_classes'
      ? {
        ...t,
        description: NO_BOOKING_CLASS_LIST_DESCRIPTION,
        input_schema: { type: 'object', properties: {} },
      }
      : t))
}

/** What Mia is told when she calls a booking-system tool at a studio without one. */
export const TOOL_NOT_AT_THIS_STUDIO = Object.freeze({
  error: 'not_available_at_this_studio',
  message:
    'That is not available at this studio. Nothing was looked up, booked or cancelled, so never ' +
    "say it was. For a class booking, send the studio's booking link if your rules give you one, " +
    'otherwise hand off to the team. For membership, payments or account questions, hand off to the team.',
})

// MIAHATCH.2 — the tools that act on, or buy from, un1t.online. None exists in
// any block yet (a later task adds them behind un1tWrites); the names are fixed
// now so the executor refuses them in every block that does not offer them.
// book_class and cancel_class_booking are Glofox tools today: they appear here
// because on a un1t.online turn they are WRITES, gated like the rest.
export const UN1T_WRITE_TOOL_NAMES = Object.freeze(new Set(['book_class', 'cancel_class_booking', 'request_refund']))
export const UN1T_PURCHASE_TOOL_NAMES = Object.freeze(new Set(['list_purchase_options', 'send_purchase_link', 'check_my_purchase']))

// Per block, the tools NOT offered in it (the executor-side mirror of the
// block's name list; tool-blocks.test.js proves the two agree). An exclusion
// list rather than an inclusion one so this stays a leaf module: the offered
// list lives with the tool definitions, which import this file.
const UN1T_ONLY = ['request_refund', ...UN1T_PURCHASE_TOOL_NAMES]
const NOT_OFFERED_IN_BLOCK = Object.freeze({
  glofox: new Set(UN1T_ONLY),
  no_booking: new Set([...BOOKING_SYSTEM_TOOL_NAMES, ...UN1T_ONLY]),
  // get_my_payment_reminder reads Glofox alone: out of both un1t read blocks
  // until it has a un1t.online source.
  un1t_read: new Set(['book_class', 'cancel_class_booking', 'get_my_payment_reminder', ...UN1T_ONLY]),
  un1t_read_dual: new Set(['get_my_payment_reminder', ...UN1T_ONLY]),
  un1t_full: new Set(),
})

/**
 * The executor-side refusal. Returns the refusal result, or null when the
 * tool may run.
 *
 * With `ctx.turn = { block, answerable, channel, un1tWrites }` (MIAHATCH.2) the
 * turn's tool block decides: a tool the block does not offer is refused, and a
 * un1t.online write or purchase tool runs only in `un1t_full` on WhatsApp with
 * `un1tWrites`. Without `ctx.turn` (an older caller, the eval harness) it is
 * today's rule: `ctx.canBook === false` is the only "no" for a booking-system
 * tool. Sonnet 5 has invented tool names before, so this runs before any read.
 */
export function refuseToolForTurn(toolName, ctx) {
  const turn = ctx?.turn
  const excluded = turn ? NOT_OFFERED_IN_BLOCK[turn.block] : undefined
  if (!excluded) {
    // No turn, or a block this build does not know: today's canBook rule, and
    // the un1t-only tools are refused regardless (no block unknown to us may
    // offer them).
    if (turn && UN1T_ONLY.includes(toolName)) return { ...TOOL_NOT_AT_THIS_STUDIO }
    if (ctx?.canBook !== false) return null
    if (!BOOKING_SYSTEM_TOOL_NAMES.has(toolName)) return null
    return { ...TOOL_NOT_AT_THIS_STUDIO }
  }
  if (excluded.has(toolName)) return { ...TOOL_NOT_AT_THIS_STUDIO }
  const full = turn.block === 'un1t_full' && turn.channel === 'whatsapp' && turn.un1tWrites === true
  if (!full && (UN1T_ONLY.includes(toolName)
    || (turn.block === 'un1t_full' && UN1T_WRITE_TOOL_NAMES.has(toolName)))) {
    return { ...TOOL_NOT_AT_THIS_STUDIO }
  }
  return null
}

// MIAHATCH.1 — a person whose only live membership is at ANOTHER studio of the
// organisation (Hatch Street, on un1t.online) while this studio's Mia is the
// one talking to them. The Stillorgan contact's Glofox columns say "no
// membership" for them, which is true of Stillorgan and false of the person, so
// the booking-system and account tools answer this instead of reading them.
export const MEMBERSHIP_AT_OTHER_STUDIO_ERROR = 'membership_at_other_studio'

/**
 * What Mia is told when the person's membership is at a studio she cannot
 * answer for yet. Plain words, no em or en dashes (it is paraphrased to the
 * customer). Pure.
 */
export function membershipAtOtherStudio(studioName) {
  const studio = String(studioName || '').trim() || 'another studio'
  return {
    error: MEMBERSHIP_AT_OTHER_STUDIO_ERROR,
    studio,
    message:
      `This person's membership is at ${studio}, which you cannot answer for yet. Nothing was looked up. ` +
      `Say you can see they train at ${studio} and hand off to the team.`,
  }
}
