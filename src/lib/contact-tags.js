// Centralised helper for writing a tag to a contact AND firing the
// tag_added sequence trigger.
//
// Why this exists:
//   1. contact_tags has no unique constraint on (contact_id, tag) so
//      idempotency must live in code — repeated writes would otherwise
//      stack duplicate rows AND re-fire sequence enrolments.
//   2. Multiple call sites (glofox-push.js, glofox-sync.js trial-
//      transition detector, future ad-hoc tag writers) need the same
//      semantics: "insert if absent, trigger sequences exactly once".
//      Inlining the SELECT-then-insert at each call site would copy-
//      paste the trigger-firing bug GLOFOX3.5 introduced.
//
// Use this helper everywhere that wants to ADD a tag to a contact.
// Direct INSERTs into contact_tags should be reserved for paths that
// genuinely don't want sequences (e.g. the inbound Glofox webhook,
// which calls triggerSequencesForTagsAdded explicitly with the
// derived tag set).

import { triggerSequencesForTagsAdded } from './sequences/triggers.js'
import { logWarn } from './log.js'

/**
 * Add a tag to a contact (idempotent) and fire any matching
 * tag_added sequence triggers.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} args.locationId
 * @param {string} args.tag
 * @param {object} [args.metadata]   optional JSONB to stash on the row
 *                                   (e.g. {from_status, to_status} for
 *                                   debugging the transition that
 *                                   wrote the tag)
 *
 * Returns { written: boolean, tag, alreadyPresent: boolean }.
 *   written       — true if a new contact_tags row was inserted
 *   alreadyPresent — true if an active row was already there (no-op)
 */
export async function writeContactTag(db, { contactId, locationId, tag, metadata = null }) {
  if (!contactId || !tag) {
    return { written: false, tag, alreadyPresent: false, error: 'missing contactId or tag' }
  }

  // Idempotency check — is there already an active (non-removed) row
  // for this (contact_id, tag) pair? If so, skip the INSERT AND skip
  // the trigger fire so we don't re-enrol an already-enrolled contact.
  const { data: existing, error: lookupErr } = await db
    .from('contact_tags')
    .select('id')
    .eq('contact_id', contactId)
    .eq('tag', tag)
    .is('removed_at', null)
    .limit(1)
  if (lookupErr) {
    logWarn('contact-tags', `lookup failed for ${contactId}/${tag}`, { err: lookupErr })
    return { written: false, tag, alreadyPresent: false, error: lookupErr.message }
  }
  if (existing && existing.length > 0) {
    return { written: false, tag, alreadyPresent: true }
  }

  const row = {
    contact_id: contactId,
    tag,
    ...(locationId ? { location_id: locationId } : {}),
    ...(metadata ? { metadata } : {}),
  }
  const { error: insertErr } = await db.from('contact_tags').insert(row)
  if (insertErr) {
    logWarn('contact-tags', `insert failed for ${contactId}/${tag}`, { err: insertErr })
    return { written: false, tag, alreadyPresent: false, error: insertErr.message }
  }

  // Fire sequence triggers. Best-effort — never blocks the caller.
  try {
    await triggerSequencesForTagsAdded(contactId, [tag])
  } catch (e) {
    logWarn('contact-tags', `sequence trigger failed for ${contactId}/${tag}`, { err: e })
  }

  return { written: true, tag, alreadyPresent: false }
}

/**
 * Bulk variant — write multiple tags in sequence, dedupe-aware. Fires
 * the sequence trigger ONCE per actually-new tag, batched in a single
 * triggerSequencesForTagsAdded call so we don't re-fetch the contact +
 * sequences per tag.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} args.locationId
 * @param {string[]} args.tags
 * @param {object} [args.metadata]
 */
export async function writeContactTags(db, { contactId, locationId, tags, metadata = null }) {
  if (!contactId || !Array.isArray(tags) || tags.length === 0) {
    return { written: [], alreadyPresent: [] }
  }
  const uniqueTags = [...new Set(tags)].filter(Boolean)

  // One round-trip to find existing active tags.
  const { data: existing } = await db
    .from('contact_tags')
    .select('tag')
    .eq('contact_id', contactId)
    .in('tag', uniqueTags)
    .is('removed_at', null)
  const alreadySet = new Set((existing || []).map((r) => r.tag))

  const toInsert = uniqueTags.filter((t) => !alreadySet.has(t))
  if (toInsert.length === 0) {
    return { written: [], alreadyPresent: [...alreadySet] }
  }

  const rows = toInsert.map((tag) => ({
    contact_id: contactId,
    tag,
    ...(locationId ? { location_id: locationId } : {}),
    ...(metadata ? { metadata } : {}),
  }))
  const { error: insertErr } = await db.from('contact_tags').insert(rows)
  if (insertErr) {
    logWarn('contact-tags', `bulk insert failed for ${contactId}`, { err: insertErr })
    return { written: [], alreadyPresent: [...alreadySet], error: insertErr.message }
  }

  try {
    await triggerSequencesForTagsAdded(contactId, toInsert)
  } catch (e) {
    logWarn('contact-tags', `bulk sequence trigger failed for ${contactId}`, { err: e })
  }

  return { written: toInsert, alreadyPresent: [...alreadySet] }
}
