// WAORGNUMBER.1 (Task 5) — helpers shared by the organisation's WhatsApp
// number routes (/api/organizations/[id]/whatsapp/*) and the studio routes that
// were retired in their favour.
//
// A number belongs to an ORGANISATION; whatsapp_numbers.location_id is its HOME
// studio: unknown senders, Meta-made templates and chat-opener edits belong to
// it. Since ORGCONTACTS.0 (mig 763 dropped mig 743's compatibility triggers) an
// insert must carry organization_id and nothing switches a new number on by
// itself: the route does, through switchOnAtHome. The database does NOT refuse
// a home studio of another organisation while organization_id is unchanged, so
// every route that sets the home studio checks it here first.

import { NextResponse } from 'next/server'
import { logError } from '@/lib/log'
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
 * Switch a NEW number on at its home studio (R1), as the studio's default when
 * it has none, naming who did it. ORGCONTACTS.0: this used to be mig 743's
 * AFTER INSERT trigger; the route owns it now.
 *
 * The number row already exists when this runs, so a failure here must not
 * undo the add: it is logged loudly and reported ({ ok: false }) and the
 * studio's WhatsApp tab can still switch the number on by hand. A link that
 * already exists (a concurrent switch-on) is success. A race on the
 * one-default-per-studio index (two numbers added at once to a studio with no
 * default) retries as non-default.
 *
 * @returns {Promise<{ ok: true, isDefault: boolean } | { ok: false }>}
 */
export async function switchOnAtHome(db, { numberId, locationId, userId }) {
  const insert = async (isDefault) => db
    .from('location_whatsapp_numbers')
    .insert({ location_id: locationId, whatsapp_number_id: numberId, is_default: isDefault, created_by: userId ?? null })
    .select('whatsapp_number_id')
  try {
    const { data: existing, error: readErr } = await db
      .from('location_whatsapp_numbers')
      .select('whatsapp_number_id, is_default')
      .eq('location_id', locationId)
    if (readErr) throw readErr
    if ((existing || []).some((l) => l.whatsapp_number_id === numberId)) {
      return { ok: true, isDefault: existing.some((l) => l.whatsapp_number_id === numberId && l.is_default) }
    }
    let isDefault = !(existing || []).some((l) => l.is_default)
    let { error } = await insert(isDefault)
    if (error && isDefault && /location_whatsapp_numbers_one_default/.test(error.message || '')) {
      isDefault = false
      ;({ error } = await insert(false))
    }
    if (error) {
      if (/location_whatsapp_numbers_pkey/.test(error.message || '')) return { ok: true, isDefault: false }
      throw error
    }
    return { ok: true, isDefault }
  } catch (e) {
    logError('wa-org-numbers', 'new number not switched on at its home studio; switch it on from the studio WhatsApp tab', {
      numberId, locationId, error: e?.message || String(e),
    })
    return { ok: false }
  }
}

/** A unique-constraint failure from a whatsapp_numbers write, as a 409 body message (or null). */
export function duplicateNumberMessage(error) {
  if (!/duplicate key|unique constraint/i.test(error?.message || '')) return null
  return /phone_number_id/i.test(error.message)
    ? 'This phone_number_id is already registered (Meta IDs are globally unique across the platform).'
    : 'A number with this label already exists at that home studio.'
}
