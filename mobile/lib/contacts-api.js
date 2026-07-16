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
//   • bookings / WhatsApp thread → direct Supabase, same RLS posture the
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

/**
 * Search contacts at a location by name / phone / email. Empty query
 * returns the most-recent contacts (a cheap default before the operator
 * types). Capped at `limit` — this is a lookup tool, not a bulk export.
 */
export async function searchContacts({ locationId, query = '', limit = 40 }) {
  if (!locationId) return { success: false, error: 'locationId required' }
  // CONTACT-DEDUP (mig 334) — the directory shows one profile per linked
  // person (the group primary); the folded accounts are reachable from it.
  let q = supabase.from('contacts').select(CONTACT_SELECT).eq('location_id', locationId)
    .eq('is_primary_contact', true)
  const term = (query || '').trim()
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
 * gated server-side on the web `consultations` permission; callers gate
 * visibility with canDashboard(profile, 'consultations', activeLocation)
 * so mobile mirrors the web card's gating exactly.
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
    .select('id, booking_date, start_time, end_time, status, event_type:event_types(name, color)')
    .eq('contact_id', contactId)
    .order('booking_date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(50)
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/**
 * The contact's most recent WhatsApp conversation, if any — powers the
 * "open thread" row that deep-links into /whatsapp/[conversationId].
 * Direct read; RLS gates on the mobile `whatsapp` permission (mig 219),
 * matching the gate on the inbox itself. No contacts embed (scalar
 * columns only), so the ≥2-FK PGRST201 trap doesn't apply.
 */
export async function getWhatsAppThreadForContact(contactId) {
  if (!contactId) return { success: false, error: 'contactId required' }
  const { data, error } = await supabase.from('whatsapp_conversations')
    .select('id, wa_phone, last_message_at, last_message_preview, last_message_direction, unread_count, status')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  if (error) return { success: false, error: error.message }
  return { success: true, data: (data || [])[0] || null }
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
