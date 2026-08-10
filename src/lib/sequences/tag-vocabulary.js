// SEQ-GLOFOX.2 — the tag vocabulary the platform itself writes, powering the
// flow builder's phantom-tag warning. A has_tag branch on a tag nothing
// writes always takes the No path and silently defeats the flow's intent
// (live bug: the First Class Booking Nudge shipped branching on
// 'first_booking_made', which no code has ever written).
//
// Client-safe on purpose: no imports — src/lib/glofox.js pulls node:crypto,
// which can't ride into the builder bundle. tag-vocabulary.test.js asserts
// PLATFORM_TAGS stays a superset of glofox.js EVENT_TYPE_TAGS so the two
// lists can't drift silently. When a new platform tag writer ships, add the
// tag here (the test forces it for webhook event tags).

export const PLATFORM_TAGS = [
  // Glofox webhook event tags (EVENT_TYPE_TAGS in lib/glofox.js)
  'glofox_member_created', 'glofox_member_updated',
  'glofox_membership_created', 'glofox_membership_updated', 'glofox_membership_deleted',
  'glofox_booking_created', 'glofox_booking_updated', 'glofox_booking_cancelled',
  'glofox_course_booking_created', 'glofox_course_booking_cancelled',
  'glofox_invoice_updated',
  'glofox_access_created', 'glofox_access_updated',
  'glofox_event_created', 'glofox_event_updated', 'glofox_event_deleted',
  'glofox_eagreement_created', 'glofox_eagreement_updated',
  'glofox_service_created', 'glofox_service_updated', 'glofox_service_deleted',
  // Once-ever first booking (webhook step 6c, SEQ-GLOFOX.2)
  'glofox_first_booking',
  // Trial-lifecycle transitions (glofox-sync.js GLOFOX4.2)
  'glofox_trial_ended', 'glofox_trial_converted', 'glofox_trial_credits_low', 'glofox_trial_engaged',
  // Race / event behaviour rules (contact-events.js TAG_RULES)
  'race_completed', 'repeat_racer', 'race_registered_no_payment',
  'lapsed_payer', 'race_starts_soon', 'race_recently_completed',
]

// FILTER-A.3 — plain-English descriptions for the platform vocabulary.
//
// /api/segments has always returned a `description` for the six behavioural
// TAG_RULES and the audience builder threw it away; now that the builder shows
// it, the other 26 tags need one too or the dropdown reads as a list of column
// names. Only the behaviourally meaningful tags get bespoke copy — the raw
// webhook echoes genuinely mean no more than "this webhook fired for them",
// and describeTag() says exactly that rather than inventing significance.
export const PLATFORM_TAG_DESCRIPTIONS = Object.freeze({
  glofox_first_booking: 'Made their very first booking (applied once, ever).',
  glofox_trial_ended: 'Their trial has finished.',
  glofox_trial_converted: 'Converted from a trial to a paid membership.',
  glofox_trial_credits_low: 'On a trial and nearly out of credits — the moment to convert them.',
  glofox_trial_engaged: 'On a trial and actively booking classes.',
  glofox_member_created: 'A member record was created for them in the booking system.',
  glofox_membership_created: 'A membership was added to their account.',
  glofox_membership_updated: 'Their membership changed (plan, price, state or dates).',
  glofox_membership_deleted: 'A membership was removed from their account.',
  glofox_booking_created: 'Booked a class.',
  glofox_booking_cancelled: 'Cancelled a booking.',
  glofox_invoice_updated: 'An invoice on their account changed status.',
  glofox_access_created: 'Was issued door access.',
  glofox_eagreement_created: 'Was sent an agreement to sign.',
  glofox_eagreement_updated: 'Their signed agreement changed.',
})

// Human description for any tag, whichever registry it came from.
// Unknown tags (an operator's own sequence wrote them) are labelled as such
// rather than given a fabricated meaning.
export function describeTag(tag, ruleDescription) {
  if (ruleDescription) return ruleDescription
  if (PLATFORM_TAG_DESCRIPTIONS[tag]) return PLATFORM_TAG_DESCRIPTIONS[tag]
  if (PLATFORM_TAGS.includes(tag)) {
    return `Applied automatically when the booking system reports "${String(tag).replace(/^glofox_/, '').replace(/_/g, ' ')}".`
  }
  return 'Added by a sequence or by staff — not one of the automatic tags.'
}

/**
 * Every tag a contact could plausibly carry from THIS flow's perspective:
 * the platform vocabulary plus any tag an apply_tag node in the given graph
 * writes (a branch downstream of its own apply_tag is a legit pattern —
 * the live nudge flow does exactly that for its sent-markers).
 *
 * @param {object|null} graph — flow graph ({ nodes: [...] })
 * @returns {Set<string>}
 */
export function knownTagVocabulary(graph) {
  const vocab = new Set(PLATFORM_TAGS)
  for (const node of graph?.nodes || []) {
    if (node?.type === 'apply_tag' && node.config?.tag) vocab.add(String(node.config.tag))
  }
  return vocab
}

/**
 * True when a has_tag branch predicate references a tag that neither the
 * platform nor this flow writes — i.e. the branch is at risk of always
 * taking the No path. Operators CAN legitimately branch on tags applied
 * manually or by another flow, so callers should render this as a soft
 * warning, never a publish blocker.
 *
 * @param {string} tag
 * @param {Set<string>} vocabulary — from knownTagVocabulary
 */
export function isPhantomTag(tag, vocabulary) {
  const t = String(tag || '').trim()
  if (!t) return false // empty is a validation problem, not a phantom
  return !vocabulary.has(t)
}
