// W1 — mobile contacts (read vertical). A searchable member directory +
// contact detail for looking someone up and calling/messaging them.
// Direct Supabase: the `contacts` table is granted to the authenticated
// role and RLS-scoped by location (contacts_location_scoped, mig 014),
// the same trust model pipeline-api.js uses. Editing stays on web.
//
// CC-M.1 — the contact detail is now a command-centre screen. Access
// paths, chosen per surface:
//   • contact row     → direct Supabase (location-scoped RLS), with the
//                       detail select extended to the denormalised Glofox
//                       columns the web GlofoxProfileCard reads (all
//                       verified against live information_schema).
//   • notes+activities→ GET /api/contacts/[id]/command-centre?scope=drawer
//                       via api(). Deliberate: notes RLS gates authenticated
//                       reads on the mobile `pipeline` permission (mig 219),
//                       so a contacts-only user would silently see an empty
//                       timeline from a direct select; the drawer bundle is
//                       the same session-authed path the web pipeline drawer
//                       uses (contact-location gate, service role) and
//                       carries activities.source for the Glofox chips.
//   • note create     → POST /api/contacts/[id]/notes via api() — the
//                       session route that ALSO pushes the note into Glofox
//                       (GLOFOX-NOTES). Never insert into notes directly
//                       here; a direct insert would skip the Glofox push.
//   • kudos           → POST /api/contacts/[id]/kudos via api() (web
//                       SendKudosCard's route; consultations-gated there).
//   • bookings / WhatsApp threads → direct Supabase, same RLS posture the
//                       Bookings tab and WhatsApp inbox already rely on.
import { supabase } from './supabase'
import { api } from './api'

// The activity + note readers already exist for the pipeline deal card —
// reuse them on the contact detail so we don't duplicate the queries.
export { listActivitiesForContact, listNotesForContact } from './pipeline-api'

const CONTACT_SELECT =
  'id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug, lead_source, tags, created_at'

// Detail-only extension: the denormalised Glofox membership + engagement
// columns the web command-centre's GlofoxProfileCard renders, plus the
// recent_bookings JSONB (Glofox class history) and location_id. Kept off
// the list/search select — recent_bookings is a fat blob and the
// directory doesn't need any of this.
const CONTACT_DETAIL_SELECT = `${CONTACT_SELECT}, location_id, joined_at,
  last_attended_at, last_payment_at, lifetime_value_cents, lifetime_currency,
  lifetime_transaction_count, trial_credits_remaining, total_attended_30d,
  total_noshow_30d, glofox_member_id, glofox_membership_status,
  glofox_membership_state, glofox_membership_plan, glofox_membership_plan_full,
  glofox_membership_price_cents, glofox_billing_interval, glofox_membership_type,
  glofox_membership_expiry, glofox_synced_at, recent_bookings`

// UN1THARD.8 / ORGCONTACTS.2 — the studio's crossovers: contacts whose
// primary studio is another one but who have a relationship here (a
// contact_studios row, mig 764: a Stillorgan member with a Hatch Street
// membership, a lapsed Hatch client, a deal on this board). The web contacts
// list shows them; the phone directory used to filter on location_id alone
// and missed them. The ids come from GET /api/mobile/contacts/crossover-ids
// (it reads the service-role-only studio_contacts view); the rows are still
// read here through RLS, which admits every relationship to a caller holding
// Contacts at the studio (mig 765) and returns nothing for an id it does not
// admit. Best-effort: a failed or refused call lists own contacts only, as
// before. Cached per studio for a minute, because search runs per keystroke.
const CROSSOVER_TTL_MS = 60 * 1000
const crossoverCache = new Map()

export async function crossoverIdsFor(locationId, now = Date.now()) {
  const hit = crossoverCache.get(locationId)
  if (hit && now - hit.at < CROSSOVER_TTL_MS) return hit.ids
  const res = await api('/api/mobile/contacts/crossover-ids', { locationId })
  const raw = res?.success ? res.data?.ids : null
  // Only a real answer is cached, so a dropped call is retried next search.
  if (!Array.isArray(raw)) return []
  // uuid-shaped only: the ids go into a PostgREST or() filter.
  const ids = raw.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
  crossoverCache.set(locationId, { ids, at: now })
  return ids
}

/** Test seam: forget the cached crossover ids. */
export function _resetCrossoverCache() {
  crossoverCache.clear()
}

// ORGCONTACTS.5 (final review I4) — the directory search is served by the
// CRM: GET /api/mobile/contacts/search reads public.studio_contacts at the
// active studio on the service role, so every relationship is listed with no
// id cap (decision 2 put the crossover count past the 100 ids a GET URL could
// carry: ≥102 at Stillorgan, ~230 at Hatch Street). The RLS read below, with
// the capped crossover ids, is the FALLBACK when the route fails or refuses:
// a bad deploy degrades to the old directory, never to an empty one.
export const MOBILE_CONTACT_SEARCH_PATH = '/api/mobile/contacts/search'

/**
 * Search contacts at a location by name / phone / email. Empty query
 * returns the most-recent contacts (a cheap default before the operator
 * types). Capped at `limit` — this is a lookup tool, not a bulk export.
 * Includes the studio's crossovers (UN1THARD.8), as the web list does.
 */
export async function searchContacts({ locationId, query = '', limit = 40 }) {
  if (!locationId) return { success: false, error: 'locationId required' }
  const term = (query || '').trim()
  const served = await api(`${MOBILE_CONTACT_SEARCH_PATH}?q=${encodeURIComponent(term)}&limit=${encodeURIComponent(String(limit))}`, { locationId })
  if (served?.success && Array.isArray(served.data?.contacts)) return { success: true, data: served.data.contacts }
  return searchContactsThroughRls({ locationId, term, limit })
}

/** The pre-ORGCONTACTS.5 directory read: own contacts OR the capped crossover ids, through RLS. */
async function searchContactsThroughRls({ locationId, term, limit }) {
  const crossIds = await crossoverIdsFor(locationId)
  // CONTACT-DEDUP (mig 334) — the directory shows one profile per linked
  // person (the group primary); the folded accounts are reachable from it.
  let q = supabase.from('contacts').select(CONTACT_SELECT).eq('is_primary_contact', true)
  q = crossIds.length > 0
    ? q.or(`location_id.eq.${locationId},id.in.(${crossIds.join(',')})`)
    : q.eq('location_id', locationId)
  if (term) {
    // Commas + % are PostgREST .or()/ilike control chars — strip them so
    // a search term can't break the filter or smuggle a wildcard.
    const safe = term.replace(/[,%]/g, ' ').trim()
    q = q.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,wa_phone.ilike.%${safe}%,email.ilike.%${safe}%`)
    q = q.order('name', { ascending: true })
  } else {
    q = q.order('created_at', { ascending: false })
  }
  const { data, error } = await q.limit(limit)
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/** One contact by id (location scope enforced by RLS). */
export async function getContact(id) {
  if (!id) return { success: false, error: 'id required' }
  const { data, error } = await supabase.from('contacts')
    .select(CONTACT_DETAIL_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: 'Contact not found' }
  return { success: true, data }
}

/**
 * CC-M.1 — the web contact drawer's one-round-trip bundle. Returns
 * { success, contact, activities, notes, sequences, wa, permissions, … }
 * (route shape, not the { success, data } envelope). Used for the merged
 * notes+activities timeline — see the access-path note at the top of
 * this file for why this is an api() call rather than direct selects.
 */
export function getContactCommandCentre(id) {
  return api(`/api/contacts/${id}/command-centre?scope=drawer`)
}

/**
 * Create a staff note on a contact via the session route — the ONE path
 * that also copies the note into Glofox as an interaction for the front
 * desk (GLOFOX-NOTES; fire-and-forget server-side, linked contacts only).
 */
export function createContactNote(contactId, content) {
  return api(`/api/contacts/${contactId}/notes`, {
    method: 'POST',
    body: { content },
  })
}

/**
 * Send a coach kudo (short congratulatory note + optional emoji) the
 * member reads in the champ app. Mirrors web SendKudosCard. The route is
 * gated server-side on `consultations` at the contact's location; the
 * contact screen shows it only when the drawer bundle's per-contact
 * `permissions.kudos` flag is true (ROLEUI.1b), the same decision.
 */
export function sendContactKudos(contactId, { message, emoji } = {}) {
  return api(`/api/contacts/${contactId}/kudos`, {
    method: 'POST',
    body: { message, emoji: emoji || undefined },
  })
}

/**
 * CRM-native event bookings for a contact (workshops, open days, races —
 * the /events flow; distinct from Glofox class bookings, which come from
 * contacts.recent_bookings). Direct read: bookings RLS gates authenticated
 * selects on the mobile `bookings` permission (mig 219), so callers should
 * only render this section when canMobile(profile, 'bookings') — otherwise
 * RLS silently returns nothing and the section would look empty for
 * permission reasons.
 */
export async function listBookingsForContact(contactId) {
  if (!contactId) return { success: false, error: 'contactId required' }
  const { data, error } = await supabase.from('bookings')
    .select('id, location_id, booking_date, start_time, end_time, status, event_type:event_types(name, color)')
    .eq('contact_id', contactId)
    .order('booking_date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(50)
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/**
 * The contact's WhatsApp conversations, newest first (CARDLENS-M.3: one per
 * studio number, so the screen lists each studio's latest thread with its
 * tag instead of one unlabelled row). Direct read; RLS returns only the
 * threads at studios where the caller holds the mobile `whatsapp` permission
 * (wa_conv_select), matching the inbox. No contacts embed (scalar columns
 * only), so the >=2-FK PGRST201 trap doesn't apply.
 */
export async function listWhatsAppThreadsForContact(contactId) {
  if (!contactId) return { success: false, error: 'contactId required' }
  const { data, error } = await supabase.from('whatsapp_conversations')
    .select('id, location_id, wa_phone, last_message_at, last_message_preview, last_message_direction, unread_count, status')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(20)
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/** new_lead → "New lead" for display. */
export function prettyStage(slug) {
  if (!slug) return null
  return slug.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

export function contactDisplayName(c) {
  if (!c) return 'Contact'
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Contact'
}
