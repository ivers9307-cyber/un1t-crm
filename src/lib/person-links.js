// src/lib/person-links.js — identity-link helpers (PERSON-LINK.1)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normalisePhone9(raw) {
  if (!raw || typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 9) return null
  return digits.slice(-9)
}

export function normaliseName(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ')
}

// Primary = the account that best represents the person for display + outreach.
// Order: non-classpass beats classpass; active beats inactive; member-status
// beats lead/none; most-recent attendance breaks ties.
const STATUS_RANK = { member: 3, credit_member: 3, trial: 2, classpass_payg: 0 }
export function pickPrimary(contacts) {
  const score = (c) => {
    const isCp = c.glofox_membership_status === 'classpass_payg'
    const active = c.glofox_account_active === true
    const attendedMs = c.last_attended_at ? Date.parse(c.last_attended_at) || 0 : 0
    return [isCp ? 0 : 1, active ? 1 : 0, STATUS_RANK[c.glofox_membership_status] ?? 1, attendedMs]
  }
  return [...contacts].sort((a, b) => {
    const sa = score(a), sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i]
    return 0
  })[0]
}

// ---------------------------------------------------------------------------
// IO group-CRUD helpers
// Each takes a service-role `db` (Supabase client).
// CRITICAL: supabase-js builders are thenables but have NO .catch — never
// write db.from(...).insert(...).catch(...). Use try { await ... } catch {}.
// ---------------------------------------------------------------------------

/**
 * createGroup(db, { contactIds, method, confidence, actorId, locationId, note })
 * → { group, members }
 *
 * Fetches contact rows for scoring, picks primary via pickPrimary,
 * inserts one person_groups row and N person_group_members rows.
 */
export async function createGroup(db, { contactIds, method, confidence, actorId, locationId, note }) {
  // Fetch contact rows for scoring
  const { data: rows } = await db
    .from('contacts')
    .select('id, glofox_membership_status, glofox_account_active, last_attended_at')
    .in('id', contactIds)

  const primary = pickPrimary(rows || [])
  if (!primary) throw new Error('createGroup requires at least one existing contact')

  // Insert group row
  const { data: group } = await db
    .from('person_groups')
    .insert({
      location_id: locationId,
      primary_contact_id: primary.id,
      created_by: actorId,
      note: note ?? null,
    })
    .select()
    .single()

  // Insert member rows — one per contactId
  const memberRows = contactIds.map(cid => ({
    group_id: group.id,
    contact_id: cid,
    match_method: method,
    confidence,
    added_by: actorId,
  }))

  const { data: members } = await db
    .from('person_group_members')
    .insert(memberRows)
    .select()

  return { group, members: members || [] }
}

/**
 * addToGroup(db, { groupId, contactIds, method, confidence, actorId })
 * → { group, members }
 *
 * Inserts member rows for contactIds into groupId, then re-derives primary
 * across ALL members. Updates primary_contact_id if it changed.
 */
export async function addToGroup(db, { groupId, contactIds, method, confidence, actorId }) {
  // Insert new member rows
  const memberRows = contactIds.map(cid => ({
    group_id: groupId,
    contact_id: cid,
    match_method: method,
    confidence,
    added_by: actorId,
  }))

  await db
    .from('person_group_members')
    .insert(memberRows)
    .select()

  // Fetch all current members of the group
  const { data: allMembers } = await db
    .from('person_group_members')
    .select('contact_id')
    .eq('group_id', groupId)

  const allContactIds = (allMembers || []).map(m => m.contact_id)

  // Fetch contact rows for scoring
  const { data: contactRows } = await db
    .from('contacts')
    .select('id, glofox_membership_status, glofox_account_active, last_attended_at')
    .in('id', allContactIds)

  const bestPrimary = pickPrimary(contactRows || [])

  // Fetch the current group row
  const { data: currentGroup } = await db
    .from('person_groups')
    .select()
    .eq('id', groupId)
    .single()

  let group = currentGroup

  // If primary changed, update it
  if (bestPrimary && currentGroup && bestPrimary.id !== currentGroup.primary_contact_id) {
    const { data: updated } = await db
      .from('person_groups')
      .update({ primary_contact_id: bestPrimary.id, updated_at: new Date().toISOString() })
      .eq('id', groupId)
      .select()
      .single()
    group = updated
  }

  // Fetch the refreshed member list
  const { data: members } = await db
    .from('person_group_members')
    .select()
    .eq('group_id', groupId)

  return { group, members: members || [] }
}

/**
 * removeFromGroup(db, { groupId, contactId })
 * → { group: Group | null, members: [] }
 *
 * Deletes the member row. If only 1 member would remain, deletes the group
 * (no orphan singleton groups). Otherwise re-derives primary if needed.
 */
export async function removeFromGroup(db, { groupId, contactId }) {
  // Delete the member row
  await db
    .from('person_group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('contact_id', contactId)

  // Fetch remaining members
  const { data: remaining } = await db
    .from('person_group_members')
    .select('contact_id')
    .eq('group_id', groupId)

  if (!remaining || remaining.length <= 1) {
    // Delete the group — FK cascade removes the last member; mig-270 trigger
    // nulls contacts.person_group_id.
    await db
      .from('person_groups')
      .delete()
      .eq('id', groupId)
    return { group: null, members: [] }
  }

  // ≥2 members remain — check if we need to re-derive primary
  const { data: currentGroup } = await db
    .from('person_groups')
    .select()
    .eq('id', groupId)
    .single()

  const removedWasPrimary = currentGroup && currentGroup.primary_contact_id === contactId

  let group = currentGroup

  if (removedWasPrimary) {
    const remainingContactIds = remaining.map(m => m.contact_id)
    const { data: contactRows } = await db
      .from('contacts')
      .select('id, glofox_membership_status, glofox_account_active, last_attended_at')
      .in('id', remainingContactIds)

    const bestPrimary = pickPrimary(contactRows || [])

    if (bestPrimary) {
      const { data: updated } = await db
        .from('person_groups')
        .update({ primary_contact_id: bestPrimary.id, updated_at: new Date().toISOString() })
        .eq('id', groupId)
        .select()
        .single()
      group = updated
    }
  }

  // Fetch refreshed member list
  const { data: members } = await db
    .from('person_group_members')
    .select()
    .eq('group_id', groupId)

  return { group, members: members || [] }
}

/**
 * setPrimary(db, { groupId, contactId })
 * → { group, members }
 *
 * Verifies contactId is a member of groupId; if not, throws.
 * Updates primary_contact_id + updated_at.
 */
export async function setPrimary(db, { groupId, contactId }) {
  // Verify membership
  const { data: member } = await db
    .from('person_group_members')
    .select('contact_id')
    .eq('group_id', groupId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (!member) {
    throw new Error('contact is not a member of this group')
  }

  // Update primary
  const { data: group } = await db
    .from('person_groups')
    .update({ primary_contact_id: contactId, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .select()
    .single()

  // Fetch members
  const { data: members } = await db
    .from('person_group_members')
    .select()
    .eq('group_id', groupId)

  return { group, members: members || [] }
}

/**
 * getPersonGroup(db, contactId)
 * → { group, members } | null
 *
 * Looks up the contact's membership. If none, returns null.
 * Otherwise fetches the group row + all its members.
 */
export async function getPersonGroup(db, contactId) {
  const { data: membership } = await db
    .from('person_group_members')
    .select('group_id')
    .eq('contact_id', contactId)
    .maybeSingle()

  if (!membership) return null

  const groupId = membership.group_id

  const { data: group } = await db
    .from('person_groups')
    .select()
    .eq('id', groupId)
    .single()

  const { data: members } = await db
    .from('person_group_members')
    .select()
    .eq('group_id', groupId)

  return { group, members: members || [] }
}
