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
