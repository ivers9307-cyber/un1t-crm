// WAORGNUMBER.1 (Task 5) — helpers shared by the organisation's WhatsApp
// number routes (/api/organizations/[id]/whatsapp/*) and the studio routes that
// were retired in their favour.
//
// A number belongs to an ORGANISATION; whatsapp_numbers.location_id is its HOME
// studio (where new-enquiry threads and coexistence history land). Mig 736 fills
// organization_id from the home studio when an insert omits it and switches the
// number on at its home studio (AFTER INSERT trigger), but it does NOT refuse a
// home studio of another organisation while organization_id is unchanged, so
// every route that sets the home studio checks it here first.

import { NextResponse } from 'next/server'
import { logWarn } from '@/lib/log'
import { ORG_NUMBERS_PAGE } from '@/lib/org-whatsapp-numbers-page'

/** The 410 the studio-level write routes answer with now numbers live at the organisation. */
export function numbersMovedToOrganisation() {
  return NextResponse.json({
    success: false,
    error: 'WhatsApp numbers are managed at the organisation now.',
    moved_to: ORG_NUMBERS_PAGE,
  }, { status: 410 })
}

/**
 * Is `locationId` a studio of organisation `orgId`?
 * @returns {Promise<{ ok: true } | { ok: false, response: NextResponse }>}
 *   a 400 when the studio is not one of the organisation's (or does not exist),
 *   a 500 when the read itself failed: never a guess.
 */
export async function requireHomeStudioInOrg(db, orgId, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id')
    .eq('id', locationId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (error) {
    return { ok: false, response: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'The home studio must be a studio of this organisation.' }, { status: 400 }),
    }
  }
  return { ok: true }
}

/**
 * Record who switched a new number on at its home studio. The row itself is the
 * database trigger's (R1): the route never inserts a link, and this is
 * bookkeeping, so a failure is logged and never fails the add.
 */
export async function stampHomeLinkCreatedBy(db, { numberId, locationId, userId }) {
  try {
    const { error } = await db
      .from('location_whatsapp_numbers')
      .update({ created_by: userId })
      .eq('whatsapp_number_id', numberId)
      .eq('location_id', locationId)
    if (error) logWarn('wa-org-numbers', 'could not stamp created_by on the home switch-on row', { numberId, locationId, error: error.message })
  } catch (e) {
    logWarn('wa-org-numbers', 'could not stamp created_by on the home switch-on row', { numberId, locationId, error: e?.message || String(e) })
  }
}

/** A unique-constraint failure from a whatsapp_numbers write, as a 409 body message (or null). */
export function duplicateNumberMessage(error) {
  if (!/duplicate key|unique constraint/i.test(error?.message || '')) return null
  return /phone_number_id/i.test(error.message)
    ? 'This phone_number_id is already registered (Meta IDs are globally unique across the platform).'
    : 'A number with this label already exists at that home studio.'
}
