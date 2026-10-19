// PIPEEXCL.1 — a Glofox studio's ACTIVE members, as contact ids (the Glofox
// adapter's activeMemberContactIds read; the un1t.online adapter has its own).
//
// Active = a contact at THIS studio holding a membership that can book today
// (hasBookableMembership: member or credit_member, state active or unset; a
// paused, locked or ex member is not active), or an ACTIVE contact_memberships
// row at this studio (UN1TDUAL, mig 722). Stored rows only, no Glofox call.
//
// { success: true, data: { contactIds } } | { success: false, error }: a failed
// read is never an empty list.
import { selectAll } from '@/lib/select-all'
import { MEMBER_STATUSES, hasBookableMembership } from '@/lib/person-accounts'

const PAGE = 1000

export async function fetchGlofoxActiveMemberContactIds(db, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  try {
    const [contacts, memberships] = await Promise.all([
      selectAll((from, to) => db
        .from('contacts')
        .select('id, glofox_membership_status, glofox_membership_state')
        .eq('location_id', locationId)
        .in('glofox_membership_status', MEMBER_STATUSES)
        .order('id', { ascending: true })
        .range(from, to), { pageSize: PAGE }),
      selectAll((from, to) => db
        .from('contact_memberships')
        .select('contact_id')
        .eq('location_id', locationId)
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, to), { pageSize: PAGE }),
    ])
    const ids = new Set()
    for (const c of contacts) if (hasBookableMembership(c)) ids.add(c.id)
    for (const m of memberships) if (m.contact_id) ids.add(m.contact_id)
    return { success: true, data: { contactIds: [...ids] } }
  } catch (e) {
    return { success: false, error: e?.message || String(e) }
  }
}
