// MIAHATCH.6 (Task 19) — the three purchase tools Mia is offered in block 3b
// (`un1t_full`: WhatsApp, the un1t.online studio's writes_enabled and its Mia
// switch). Definitions only, so auto-reply.js can build the cached block from
// them without loading the write side; the executors live in
// purchase-intents.js (loaded lazily by the turn).
//
// Model-facing text: no em or en dashes, nothing about how full a class is,
// and nothing that lets the model say "paid" on its own word. The optional
// parameters (send_purchase_link's class context) are counted in
// tool-schemas.test.js (UN1T_FULL_CEILING).

export const LIST_PURCHASE_OPTIONS_TOOL = Object.freeze({
  name: 'list_purchase_options',
  description:
    'List what a member can buy from chat at the un1t.online studio: class packs and memberships, each with an ' +
    'offer_id, a title, a price_label, the credits it gives when known and a short blurb, and trial_available: whether ' +
    'this member can have the free trial first. Use it when a member asks ' +
    'to buy classes or a membership, or asks what they can buy. Give each title and price_label exactly as listed; ' +
    'never invent, round or change a price, and never offer anything that is not on the list. When it gives open_link, ' +
    'a payment link for that product is already waiting: never offer to send a link for a different product.',
  input_schema: { type: 'object', properties: {} },
})

export const SEND_PURCHASE_LINK_TOOL = Object.freeze({
  name: 'send_purchase_link',
  description:
    "Create the VERIFIED member's secure payment link for one offer from list_purchase_options (or from book_class's " +
    'needs_purchase offers), or give the free trial with offer_id "trial", only when a tool said trial_available. ' +
    "The offer_id MUST be one that list_purchase_options (or book_class's needs_purchase offers) returned in this " +
    'conversation, copied exactly; never invent, guess or build one from a product name. ' +
    'Before calling this, restate the product and its price and get a clear yes (a member who has already asked you ' +
    'for that product\'s link has said yes); never call it on an ambiguous message. When they wanted a class, also pass that class exactly as list_upcoming_classes gave it. ' +
    'Only one payment link is open per member: for the same product the result resends it; if one is already waiting ' +
    'for a different product, no link is made and the conversation is handed to the team. ' +
    'Relay the result honestly. Never say they have paid until a tool says so. Only works after verify_identity has ' +
    'succeeded this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      offer_id: { type: 'string', description: 'The offer_id of the offer they chose, as returned by list_purchase_options in this conversation and copied exactly, or "trial" for the free trial; never invent one.' },
      event_id: { type: 'string', description: 'Only when they wanted a class: its "un1t:" event_id from list_upcoming_classes, copied exactly.' },
      class_name: { type: 'string', description: 'Only with event_id: the class name you confirmed.' },
      class_time: { type: 'string', description: 'Only with event_id: the class day and time you confirmed.' },
      starts_at: { type: 'string', description: 'Only with event_id: the starts_at from list_upcoming_classes, copied exactly.' },
    },
    required: ['offer_id'],
  },
})

export const CHECK_MY_PURCHASE_TOOL = Object.freeze({
  name: 'check_my_purchase',
  description:
    'Check on the VERIFIED member\'s payment link when they say they have paid or ask whether their payment went ' +
    'through. Relay what it says. Never say they have paid, or that anything is booked, unless this tool says so. ' +
    'Only works after verify_identity has succeeded this conversation.',
  input_schema: { type: 'object', properties: {} },
})

/** The purchase tools, in the order block 3b offers them (after request_refund). */
export const PURCHASE_TOOLS = Object.freeze([LIST_PURCHASE_OPTIONS_TOOL, SEND_PURCHASE_LINK_TOOL, CHECK_MY_PURCHASE_TOOL])

/** Their names (tool-capability.js's UN1T_PURCHASE_TOOL_NAMES holds the same three; tool-blocks.test.js proves it). */
export const PURCHASE_TOOL_NAMES = Object.freeze(new Set(PURCHASE_TOOLS.map((t) => t.name)))
