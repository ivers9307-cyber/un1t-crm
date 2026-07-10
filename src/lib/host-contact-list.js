// Host contact list (HOST-EMAIL.1).
//
// A host's list = people who took part in THAT host's events (source='event')
// + their mailing-list signups (source='mailing_list', PR-B) — and ONLY those
// people. Membership is deliberately broad (rows are added regardless of
// consent); EMAILABILITY is a send-time predicate — isEmailable below — that
// mirrors the broadcast send path's exact marketing gate:
//
//   postmark.js buildAudienceQuery (marketing):
//     .eq('email_marketing', true)
//     .not('email_status', 'in', '("bounced","complained")')
//     .is('email_suppressed_at', null)        // EMAIL-HYGIENE.1, mig 395
//   campaign-sender.js consentOk (post-claim re-check):
//     email_marketing === true && !['bounced','complained'].includes(email_status)
//
// An unsubscribe (api/unsubscribe/[token]) stamps email_status='unsubscribed'
// AND flips email_marketing to false (denormalised from contact_preferences,
// mig 155) — both are blocked here. On top of the global gate, PR-B's per-host
// unsubscribe (host_email_suppressions) is passed in as `suppressed`.
//
// Tables (mig 400): host_contacts (UNIQUE(host_id, contact_id)),
// host_email_suppressions (UNIQUE(host_id, contact_id)). Service-role only.

const PAGE = 1000        // the supabase-js 1k select cap — always .range()-paginate
const UPSERT_CHUNK = 500 // rows per host_contacts upsert statement

// email_status values that block a marketing send. buildAudienceQuery only
// filters bounced/complained (unsubscribed is already covered by
// email_marketing=false), but the unsubscribe route DOES stamp
// email_status='unsubscribed' — blocking it here too is a belt-and-braces
// mirror of the full flag family.
const BLOCKED_EMAIL_STATUSES = ['bounced', 'complained', 'unsubscribed']

/**
 * The CRM tag for a host's mailing-list signups (PR-B writes it to BOTH
 * contacts.tags and contact_tags). `host:` + the host's slug, falling back to
 * the normalized name (lowercased, non-alphanumeric runs → '-', trimmed).
 * Pure. Degenerate input falls back to 'host' so the tag is never empty.
 * @param {{slug?: string|null, name?: string|null}|null} host
 * @returns {string} e.g. 'host:acme-events'
 */
export function hostTagFor(host) {
  const base = String(host?.slug || host?.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `host:${base || 'host'}`
}

/**
 * Send-time emailability predicate — the SAME gate PR-C's send path uses.
 * Pure: the caller loads the contact flags + the per-host suppression set.
 * @param {object|null} contact  contacts row with email, email_marketing,
 *   email_status, email_suppressed_at
 * @param {boolean} suppressed   contact_id ∈ host_email_suppressions for this host
 * @returns {boolean}
 */
export function isEmailable(contact, suppressed) {
  if (suppressed) return false
  if (!contact) return false
  if (!contact.email) return false
  if (contact.email_marketing !== true) return false
  if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status ?? 'active')) return false // NULL = legacy 'active' (column default, mig 005)
  if (contact.email_suppressed_at) return false
  return true
}

/**
 * Sync a host event's CONFIRMED attendees into the host's contact list.
 * Loads the race; internal events (host_id NULL) are a no-op. Confirmed
 * registrations' team members with a linked contact_id are deduped and
 * upserted into host_contacts (ignoreDuplicates — membership rows are
 * insert-once; re-running is always safe, which is what makes the backfill
 * route idempotent).
 *
 * Callers hook this fire-and-forget after a registration flips to
 * 'confirmed' (race-payments free path + webhook path, the operator
 * manual-add) — each with its OWN try/catch, so a failure here can never
 * affect the payment/registration response. Errors THROW for those catchers.
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} raceEventId
 * @returns {Promise<number>} deduped contact count upserted (0 for no-op)
 */
export async function addEventAttendeesToHostList(db, raceEventId) {
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, host_id')
    .eq('id', raceEventId)
    .maybeSingle()
  if (raceErr) throw new Error(`host contact list: race load failed: ${raceErr.message}`)
  if (!race || !race.host_id) return 0

  // Confirmed registrations → team members with a contact link. Mirrors
  // fetchEventAttendees' query shape (attendee-export.js) trimmed to the
  // contact ids, range-paginated past the 1k cap.
  const contactIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, teams:team_id ( team_members ( contact_id ) )')
      .eq('race_event_id', raceEventId)
      .eq('status', 'confirmed')
      .order('registered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host contact list: registrations query failed: ${error.message}`)
    for (const reg of data || []) {
      const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
      for (const m of members) {
        if (m?.contact_id) contactIds.add(m.contact_id)
      }
    }
    if (!data || data.length < PAGE) break
  }
  if (contactIds.size === 0) return 0

  const rows = [...contactIds].map((contactId) => ({
    host_id: race.host_id,
    contact_id: contactId,
    source: 'event',
    source_event_id: raceEventId,
  }))
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK)
    const { error } = await db
      .from('host_contacts')
      .upsert(chunk, { onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    if (error) throw new Error(`host contact list: upsert failed: ${error.message}`)
  }
  return rows.length
}

/**
 * A host's contact list rows for the portal Contacts page / CSV export —
 * membership joined to the contact's identity + the exact consent flags
 * isEmailable reads, with the host's suppression set applied. Both queries
 * are scoped .eq('host_id', hostId): the CALLER is responsible only for
 * resolving hostId from getCurrentHost() — a host can never see another
 * host's rows through this. Range-paginated. Newest membership first.
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} hostId
 * @returns {Promise<Array<{contact_id:string, name:string, email:string,
 *   source:string, created_at:string, emailable:boolean}>>}
 */
export async function fetchHostContactRows(db, hostId) {
  const memberships = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_contacts')
      .select(`
        contact_id, source, created_at,
        contact:contacts!contact_id ( id, name, email, email_marketing, email_status, email_suppressed_at )
      `)
      .eq('host_id', hostId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host contact list: contacts query failed: ${error.message}`)
    memberships.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  const suppressedIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', hostId)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host contact list: suppressions query failed: ${error.message}`)
    for (const row of data || []) suppressedIds.add(row.contact_id)
    if (!data || data.length < PAGE) break
  }

  return memberships.map((m) => {
    const contact = m.contact || null
    return {
      contact_id: m.contact_id,
      name: contact?.name || '',
      email: contact?.email || '',
      source: m.source,
      created_at: m.created_at,
      emailable: isEmailable(contact, suppressedIds.has(m.contact_id)),
    }
  })
}
