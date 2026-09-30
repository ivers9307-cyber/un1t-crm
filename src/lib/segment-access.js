// SEGMENTROUTE.1: who may read and change a studio's saved segments
// (contact_segments), judged AT the segment's studio, after membership.
//
// Since mig 672 the /api/contacts/segments* routes are the only way to write a
// segment, so their gate is the whole fence. It used to be membership alone.
//
//   read   contacts OR email OR whatsapp: the screens that list segments are
//          /contacts (contacts), the send composer and the sequence builder
//          (email or whatsapp) and the Communications Segments tab (Manager+).
//   write  contacts: /contacts is the only screen that saves or deletes one,
//          and it shows both to everyone who can open it.
//   a segment a sequence's trigger names: changing or deleting it changes who
//          that sequence enrols (segment-sync fires segment_added for everyone
//          a widened filter takes in), so it also needs the sequence builder's
//          own rule (email or whatsapp, src/lib/sequence-access.js).

import { NextResponse } from 'next/server'
import { hasPermissionForLocation } from '@/lib/permissions'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'

export const SEGMENT_READ_PERMISSIONS = Object.freeze(['contacts', 'email', 'whatsapp'])
export const SEGMENT_WRITE_PERMISSION = 'contacts'
export const SEGMENT_TRIGGER_TYPES = Object.freeze(['segment_added', 'segment_removed'])

export const SEGMENT_READ_ERROR = 'Contacts, Email or WhatsApp permission required'
export const SEGMENT_WRITE_ERROR = 'Contacts permission required'
export const SEGMENT_IN_USE_ERROR = 'This segment starts a sequence: changing it needs the Email or WhatsApp permission'

/** Read rule at `locationId` (role, overrides, template and features there). */
export function canReadSegmentsAt(user, locationId) {
  if (!user || !locationId) return false
  return SEGMENT_READ_PERMISSIONS.some((key) => hasPermissionForLocation(user, locationId, key))
}

/** Write rule at `locationId`. */
export function canWriteSegmentsAt(user, locationId) {
  if (!user || !locationId) return false
  return hasPermissionForLocation(user, locationId, SEGMENT_WRITE_PERMISSION)
}

export { canBuildSequencesAt }

/**
 * How many sequences at the segment's studio start from this segment, in any
 * status (a draft wired to it goes live on activation).
 * A failed read is { count: null, error }, never 0.
 */
export async function countSequencesUsingSegment(db, segment) {
  const { count, error } = await db
    .from('email_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', segment.location_id)
    .in('trigger_type', SEGMENT_TRIGGER_TYPES)
    .eq('trigger_config->>segment_id', segment.id)
  if (error) return { count: null, error }
  return { count: count ?? 0, error: null }
}

/**
 * FILTER-P1.5 at save time, for POST and PUT alike: null when the filter
 * would resolve, else the 400 to answer with. Any other throw is a bug and
 * escapes. (Lives here because a route file may export only handlers.)
 */
export function audienceFilterRefusal(filter) {
  try {
    validateAudienceFilter(filter)
    return null
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }
}

const refuse = (error) => NextResponse.json({ success: false, error }, { status: 403 })
export const segmentReadRefused = () => refuse(SEGMENT_READ_ERROR)
export const segmentWriteRefused = () => refuse(SEGMENT_WRITE_ERROR)
export const segmentInUseRefused = () => refuse(SEGMENT_IN_USE_ERROR)
// The body assertLocationAccessOr404 gives another studio's segment, so a
// missing id and a foreign one cannot be told apart.
export const segmentNotFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
