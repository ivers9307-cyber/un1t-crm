// FEES.4 — members who are never charged a class fee at a studio (Richard,
// 28 Oct 2026). Staff add and remove them on /class-fees or the member's
// contact page. An exempt member's offences are still written, as waived with
// waive_rule 'exempt', so the History tab shows what was let off.
//
// Adding a member also waives every fee they owe or are due at that studio
// (preview, pending, scheduled for retry, outstanding, appealed): "never
// charged" holds from the moment they are added. Removing them changes no
// past fee.

import { WAIVABLE_STATUSES } from './class-fees.js'
import { logInfo } from './log'

export const EXEMPT_REASON = 'Exempt member, never charged'

function dbError(what, error) {
  return Object.assign(new Error(`class fee exemptions: ${what} failed (${error?.code ?? 'no code'})`), { code: error?.code ?? null })
}

/** The exempt contact ids among `contactIds` at the studio (all of them when omitted). */
export async function exemptContactIds(db, locationId, contactIds = null) {
  const ids = contactIds ? [...new Set(contactIds.filter(Boolean))] : null
  if (ids && !ids.length) return new Set()
  const out = new Set()
  const chunks = ids ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100)) : [null]
  for (const part of chunks) {
    let q = db.from('class_fee_exemptions').select('contact_id').eq('location_id', locationId)
    if (part) q = q.in('contact_id', part)
    const { data, error } = await q.order('contact_id').limit(500)
    if (error) throw dbError('read', error)
    for (const r of data || []) out.add(r.contact_id)
  }
  return out
}

/** The studio's exempt members, newest first, with their names. */
export async function listExemptions(db, locationId) {
  const { data, error } = await db
    .from('class_fee_exemptions')
    .select('id, contact_id, note, added_by, created_at')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw dbError('list', error)
  const rows = data || []
  const ids = [...new Set(rows.map((r) => r.contact_id))]
  const names = new Map()
  for (let i = 0; i < ids.length; i += 100) {
    const { data: cs, error: cErr } = await db.from('contacts').select('id, first_name, last_name, email').in('id', ids.slice(i, i + 100)).limit(100)
    if (cErr) throw dbError('contact read', cErr)
    for (const c of cs || []) names.set(c.id, { name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, email: c.email ?? null })
  }
  return rows.map((r) => ({ ...r, member_name: names.get(r.contact_id)?.name ?? null, member_email: names.get(r.contact_id)?.email ?? null }))
}

/**
 * The contact may be exempted at the studio only when it belongs to the
 * studio's organisation (contacts are shared per organisation).
 */
async function contactInStudioOrg(db, locationId, contactId) {
  const { data: loc, error: lErr } = await db.from('locations').select('id, organization_id').eq('id', locationId).maybeSingle()
  if (lErr) throw dbError('location read', lErr)
  const { data: contact, error: cErr } = await db.from('contacts').select('id, location_id').eq('id', contactId).maybeSingle()
  if (cErr) throw dbError('contact read', cErr)
  if (!loc || !contact?.location_id) return false
  if (contact.location_id === locationId) return true
  const { data: home, error: hErr } = await db.from('locations').select('id, organization_id').eq('id', contact.location_id).maybeSingle()
  if (hErr) throw dbError('home studio read', hErr)
  return !!home && !!loc.organization_id && home.organization_id === loc.organization_id
}

/** Waive every open fee of exempt contacts at the studio. → how many. */
export async function waiveFeesOfExempt(db, { locationId, contactIds, nowMs = Date.now() }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (!ids.length) return 0
  const { data, error } = await db
    .from('class_fees')
    .update({ status: 'waived', waive_rule: 'exempt', waived_reason: EXEMPT_REASON, waived_at: new Date(nowMs).toISOString(), waived_by: null, next_attempt_at: null })
    .eq('location_id', locationId)
    .eq('penalty', 'fee')
    .in('contact_id', ids)
    .in('status', WAIVABLE_STATUSES)
    .select('id')
  if (error) throw dbError('waive', error)
  return (data || []).length
}

/**
 * Add a member. → { ok: true, waived } | { ok: false, reason: 'not_found' }
 * Adding someone already exempt is fine (the note is kept as it was).
 */
export async function addExemption(db, { locationId, contactId, note = null, actorId = null }) {
  if (!(await contactInStudioOrg(db, locationId, contactId))) return { ok: false, reason: 'not_found' }
  const { error } = await db
    .from('class_fee_exemptions')
    .upsert(
      { location_id: locationId, contact_id: contactId, note: note ? String(note).trim().slice(0, 500) || null : null, added_by: actorId },
      { onConflict: 'location_id,contact_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) throw dbError('add', error)
  const waived = await waiveFeesOfExempt(db, { locationId, contactIds: [contactId] })
  logInfo('class-fees', 'member exempted from class fees', { locationId, waived })
  return { ok: true, waived }
}

/** Remove a member. Past fees are not touched. → { ok: true, removed } */
export async function removeExemption(db, { locationId, contactId }) {
  const { data, error } = await db
    .from('class_fee_exemptions')
    .delete()
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .select('id')
  if (error) throw dbError('remove', error)
  return { ok: true, removed: (data || []).length }
}
