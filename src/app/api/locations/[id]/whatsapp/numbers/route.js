// WA-MULTI.1 / WAORGNUMBER.1 — the organisation's WhatsApp numbers as one
// studio sees them.
//
// A number belongs to the ORGANISATION (added and edited at /settings/whatsapp-
// numbers); a studio only SWITCHES it on or off, and picks its default. The
// switch is a location_whatsapp_numbers row (mig 743).
//
// GET  /api/locations/[id]/whatsapp/numbers
//   Every number of the studio's organisation: { id, label, display_phone,
//   is_active, on, is_default }. `on` = switched on at THIS studio, `is_default`
//   = this studio's default. No token or other credential is returned.
//
// PUT  /api/locations/[id]/whatsapp/numbers   { numberId, on, isDefault? }
//   Owner / manager / master AT THIS STUDIO (ADMIN_ROLES; a head coach cannot
//   switch a studio's WhatsApp on). The number must be the studio's
//   organisation's (404 otherwise). Responds with the same list as the GET.
//   - isDefault:true (with on:true) makes it the default: the previous default
//     is cleared FIRST (the one-default-per-studio partial unique index would
//     refuse two), then this one is set.
//   - on:true at a studio with no default makes the number the default.
//   - on:false on the default promotes the newest remaining switched-on number
//     (active ones first); on:false on the last one is allowed: the studio stops
//     sending (the resolvers refuse with WhatsAppNumberMissingError).
//
// POST /api/locations/[id]/whatsapp/numbers
//   RETIRED (WAORGNUMBER.1): numbers are added at the organisation now —
//   POST /api/organizations/[id]/whatsapp/numbers. Answers 410 with a
//   pointer to the hub's WhatsApp numbers drawer (ORG_NUMBERS_PAGE).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES, studioWhatsAppNumberSwitchSchema } from '@/lib/schemas'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { numbersMovedToOrganisation } from '@/lib/org-whatsapp-numbers'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error, status = 500) => NextResponse.json({ success: false, error }, { status })
// ROUTEWRAP.R13 — a failed read or write is logged with the database's text and
// answered with a fixed line (same 500), so that text never reaches a browser.
const LOG = 'wa-studio-numbers'
const readFailed = (err, ctx) => {
  logError(LOG, 'studio numbers read failed', { ...ctx, err })
  return fail('Could not load the WhatsApp numbers. Try again.')
}
const writeFailed = (err, ctx) => {
  logError(LOG, 'studio number switch failed', { ...ctx, err })
  return fail('Could not save the WhatsApp number change. Try again.')
}

// The studio's organisation, or a response when it cannot be read / has none.
async function studioOrganisation(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) return { response: readFailed(error, { locationId }) }
  if (!data?.organization_id) return { response: fail('Studio not found', 404) }
  return { orgId: data.organization_id }
}

// The organisation's numbers (the public columns only: never the token) joined
// to this studio's links, default first then switched-on, then by label.
async function studioNumbers(db, locationId, orgId) {
  const { data: numbers, error: numErr } = await db
    .from('whatsapp_numbers')
    .select('id, label, display_phone, is_active, created_at')
    .eq('organization_id', orgId)
  if (numErr) return { error: numErr }
  const { data: links, error: linkErr } = await db
    .from('location_whatsapp_numbers')
    .select('whatsapp_number_id, is_default, created_at')
    .eq('location_id', locationId)
  if (linkErr) return { error: linkErr }
  const byNumber = new Map((links || []).map((l) => [l.whatsapp_number_id, l]))
  const list = (numbers || []).map((n) => {
    const l = byNumber.get(n.id)
    return {
      id: n.id,
      label: n.label,
      display_phone: n.display_phone ?? null,
      is_active: n.is_active !== false,
      on: Boolean(l),
      is_default: Boolean(l?.is_default),
      _createdAt: n.created_at || '',
    }
  })
  list.sort((a, b) =>
    (b.is_default - a.is_default) || (b.on - a.on) || a._createdAt.localeCompare(b._createdAt) || a.id.localeCompare(b.id))
  return { numbers: list.map(({ _createdAt, ...n }) => n), links: links || [] }
}

// ROUTEWRAP.R13 — withAuth signs the caller in and (location: 'param') 404s a
// studio they are not at; the hand-written checks below still decide, in their
// old order, all at the studio in the path.
export const GET = withAuth({ permission: null, location: 'param' }, async ({ user, params }) => {
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const org = await studioOrganisation(db, params.id)
  if (org.response) return org.response
  const out = await studioNumbers(db, params.id, org.orgId)
  if (out.error) return readFailed(out.error, { locationId: params.id })
  return NextResponse.json({ success: true, data: { numbers: out.numbers } })
})

export const PUT = withAuth({ permission: null, location: 'param' }, async ({ user, request, params }) => {
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, params.id, ADMIN_ROLES)) {
    return fail('Only an owner or manager can switch WhatsApp numbers on or off at this studio.', 403)
  }

  const result = await validateBody(request, studioWhatsAppNumberSwitchSchema)
  if (!result.ok) return result.response
  const { numberId, on, isDefault } = result.data
  const locationId = params.id

  const db = createServerClient()
  const org = await studioOrganisation(db, locationId)
  if (org.response) return org.response

  // The number must be the studio's organisation's: another organisation's
  // (or no such number) is a 404, so ids cannot be probed across tenants.
  const { data: number, error: numberErr } = await db
    .from('whatsapp_numbers')
    .select('id')
    .eq('id', numberId)
    .eq('organization_id', org.orgId)
    .maybeSingle()
  if (numberErr) return readFailed(numberErr, { locationId, numberId })
  if (!number) return fail('WhatsApp number not found', 404)

  const before = await studioNumbers(db, locationId, org.orgId)
  if (before.error) return readFailed(before.error, { locationId })
  const existing = before.links.find((l) => l.whatsapp_number_id === numberId) || null
  const otherDefault = before.links.find((l) => l.is_default && l.whatsapp_number_id !== numberId) || null

  // Clear the studio's other default FIRST (the partial unique index allows
  // one), reporting a failure; puts it back if the step after it fails.
  async function clearOtherDefault() {
    const { error } = await db
      .from('location_whatsapp_numbers')
      .update({ is_default: false })
      .eq('location_id', locationId)
      .eq('is_default', true)
      .neq('whatsapp_number_id', numberId)
    return error
  }
  async function restoreOtherDefault() {
    if (!otherDefault) return
    const { error } = await db
      .from('location_whatsapp_numbers')
      .update({ is_default: true })
      .eq('location_id', locationId)
      .eq('whatsapp_number_id', otherDefault.whatsapp_number_id)
    if (error) logWarn('wa-studio-numbers', 'could not restore the studio default after a failed switch', { locationId, numberId: otherDefault.whatsapp_number_id, error: error.message })
  }

  if (on) {
    // A studio with no default makes the first number it switches on its default.
    const makeDefault = isDefault === true || !before.links.some((l) => l.is_default)
    if (!existing) {
      if (makeDefault && otherDefault) {
        const clearErr = await clearOtherDefault()
        if (clearErr) return writeFailed(clearErr, { locationId, numberId })
      }
      const { error } = await db
        .from('location_whatsapp_numbers')
        .insert({ location_id: locationId, whatsapp_number_id: numberId, is_default: makeDefault, created_by: user.id })
      if (error) {
        await restoreOtherDefault()
        // Mig 743's same-organisation trigger: not this studio's organisation's number.
        if (/belongs to another organisation/i.test(error.message || '')) return fail('WhatsApp number not found', 404)
        return writeFailed(error, { locationId, numberId })
      }
    } else if (makeDefault && !existing.is_default) {
      if (otherDefault) {
        const clearErr = await clearOtherDefault()
        if (clearErr) return writeFailed(clearErr, { locationId, numberId })
      }
      const { error } = await db
        .from('location_whatsapp_numbers')
        .update({ is_default: true })
        .eq('location_id', locationId)
        .eq('whatsapp_number_id', numberId)
      if (error) {
        await restoreOtherDefault()
        return writeFailed(error, { locationId, numberId })
      }
    }
  } else if (existing) {
    const { error } = await db
      .from('location_whatsapp_numbers')
      .delete()
      .eq('location_id', locationId)
      .eq('whatsapp_number_id', numberId)
    if (error) return writeFailed(error, { locationId, numberId })

    if (existing.is_default) {
      // Promote the newest remaining switched-on number (an active one first:
      // the resolvers only use active numbers). None left: the studio stops sending.
      const activeIds = new Set(before.numbers.filter((n) => n.is_active).map((n) => n.id))
      const remaining = before.links
        .filter((l) => l.whatsapp_number_id !== numberId)
        .sort((a, b) =>
          (activeIds.has(b.whatsapp_number_id) - activeIds.has(a.whatsapp_number_id))
          || String(b.created_at || '').localeCompare(String(a.created_at || ''))
          || String(a.whatsapp_number_id).localeCompare(String(b.whatsapp_number_id)))
      const next = remaining[0]
      if (next) {
        const { error: promoteErr } = await db
          .from('location_whatsapp_numbers')
          .update({ is_default: true })
          .eq('location_id', locationId)
          .eq('whatsapp_number_id', next.whatsapp_number_id)
        if (promoteErr) return writeFailed(promoteErr, { locationId, numberId: next.whatsapp_number_id })
      }
    }
  }

  const after = await studioNumbers(db, locationId, org.orgId)
  if (after.error) return readFailed(after.error, { locationId })
  return NextResponse.json({ success: true, data: { numbers: after.numbers } })
})

// Retired: any signed-in caller gets the 410 pointer, with no studio check.
// ROUTEWRAP.R13 — left off withAuth on purpose: location: 'param' would answer
// a non-member 404 instead of 410 and make its gate row 'membership', and any
// other withAuth here reads as the active studio to role-at-path.test.js.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  return numbersMovedToOrganisation()
}
