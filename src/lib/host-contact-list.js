// Host contact list (HOST-EMAIL.1).
//
// A host's list = people who took part in THAT host's events (source='event')
// + their mailing-list signups (source='mailing_list', PR-B) — and ONLY those
// people. Membership is deliberately broad (rows are added regardless of
// consent); EMAILABILITY is a send-time predicate — isEmailable below.
//
// HOST-CONSENT.1 — host marketing email is its OWN consent domain: the
// marketing gate is host_contacts.marketing_consent (mig 588), passed in as
// `opts.hostConsent`, NOT contacts.email_marketing (the UN1T-wide flag) — a
// UN1T unsubscribe is not a host opt-out. On top of that, PR-B's per-host
// unsubscribe (host_email_suppressions) is passed in as `suppressed`, and
// the shared mailbox facts (bounced/complained email_status,
// email_suppressed_at) still block, same as the UN1T broadcast send path
// (postmark.js buildAudienceQuery / campaign-sender.js consentOk) — those
// describe the mailbox, not which consent domain granted the send.
//
// Tables (mig 400): host_contacts (UNIQUE(host_id, contact_id)),
// host_email_suppressions (UNIQUE(host_id, contact_id)). Service-role only.

import { writeContactTag } from '@/lib/contact-tags'
import { grantHostConsentBulk } from '@/lib/host-consent'
import { logWarn } from '@/lib/log'

const PAGE = 1000        // the supabase-js 1k select cap — always .range()-paginate
const UPSERT_CHUNK = 500 // rows per host_contacts upsert statement

// email_status values that block a marketing send — exactly what
// buildAudienceQuery filters. 'unsubscribed' is retired (mig 492, CHECK in
// mig 501): a real opt-out from a HOST list is hostConsent=false or a
// host_email_suppressions row, both blocked by the marketing branch of
// isEmailable below — email_status stays reputation-only.
const BLOCKED_EMAIL_STATUSES = ['bounced', 'complained']

// Shared normalisation for both host and event tags: lowercase, collapse
// any run of non-alphanumerics to a single '-', trim leading/trailing
// dashes, and fall back to `fallback` when nothing usable remains — so a
// tag built from degenerate input is never empty.
function tagBase(input, fallback) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || fallback
}

/**
 * The CRM tag for a host's mailing-list signups (PR-B writes it to BOTH
 * contacts.tags and contact_tags). `host:` + the host's slug, falling back to
 * the normalized name (lowercased, non-alphanumeric runs → '-', trimmed).
 * Pure. Degenerate input falls back to 'host' so the tag is never empty.
 * @param {{slug?: string|null, name?: string|null}|null} host
 * @returns {string} e.g. 'host:acme-events'
 */
export function hostTagFor(host) {
  return `host:${tagBase(host?.slug || host?.name, 'host')}`
}

/**
 * HOST-MASTER.3 — one tag per race event a contact attends. `event:` + the
 * event's slug, falling back to the normalized name. Pure; mirrors hostTagFor's
 * normalisation via the shared tagBase() helper.
 * @param {{slug?: string|null, name?: string|null}|null} raceEvent
 * @returns {string} e.g. 'event:pride-sep20'
 */
export function eventTagFor(raceEvent) {
  return `event:${tagBase(raceEvent?.slug || raceEvent?.name, 'event')}`
}

/**
 * HOST-METRICS.1 — WHY a contact cannot be mailed, or null when they can.
 * The single predicate behind isEmailable, so the queue can stamp
 * host_campaign_sends.failed_reason with the same decision the gate makes.
 * Reasons: 'no_email' | 'mailbox_blocked' | 'no_administrative_consent'
 *        | 'host_unsubscribed' | 'no_host_consent'.
 */
export function emailabilityReason(contact, suppressed, { emailType = 'marketing', hostConsent = false } = {}) {
  if (!contact || !contact.email) return 'no_email'
  if (contact.email_suppressed_at) return 'mailbox_blocked'
  if (emailType === 'utility') {
    if (contact.email_administrative !== true) return 'no_administrative_consent'
    if (['bounced', 'complained'].includes(contact.email_status ?? 'active')) return 'mailbox_blocked'
    return null
  }
  if (suppressed) return 'host_unsubscribed'
  if (hostConsent !== true) return 'no_host_consent'
  if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status ?? 'active')) return 'mailbox_blocked' // NULL = legacy 'active' (column default, mig 005)
  return null
}

/**
 * Send-time emailability predicate — the SAME gate the send path uses.
 * Pure: the caller loads the contact flags, the per-host suppression set and
 * the host_contacts.marketing_consent value.
 *
 * HOST-CONSENT.1 — host marketing is its own consent domain:
 *   marketing (default)  opts.hostConsent === true (host_contacts.marketing_consent),
 *                        no host_email_suppressions row, and the mailbox facts
 *                        below. It does NOT read contacts.email_marketing any
 *                        more — a UN1T opt-out is not a host opt-out.
 *   utility              operational messages to attendees (time change,
 *                        instructions) — email_administrative === true;
 *                        marketing opt-outs do NOT block it, deliverability
 *                        blocks (bounced / complained / suppressed_at) do.
 * Shared on purpose: email_status bounced/complained and the repeat-bounce
 * stamp email_suppressed_at describe the MAILBOX, not the relationship.
 *
 * hostConsent defaults to false so a caller that forgets it fails closed.
 *
 * HOST-METRICS.1 — wraps emailabilityReason: true iff the reason is null.
 *
 * @param {object|null} contact  contacts row with email, email_administrative,
 *   email_status, email_suppressed_at
 * @param {boolean} suppressed   contact_id ∈ host_email_suppressions for this host
 * @param {{emailType?: 'marketing'|'utility', hostConsent?: boolean}} [opts]
 * @returns {boolean}
 */
export function isEmailable(contact, suppressed, opts = {}) {
  return emailabilityReason(contact, suppressed, opts) === null
}

/**
 * Sync a host event's CONFIRMED attendees into the host's contact list.
 * Loads the race; internal events (host_id NULL) are a no-op. Confirmed
 * registrations' team members with a linked contact_id are deduped and
 * upserted into host_contacts (ignoreDuplicates — membership rows are
 * insert-once; re-running is always safe, which is what makes the backfill
 * route idempotent).
 *
 * HOST-MASTER.5 — every deduped attendee is ALSO tagged with the host tag
 * (hostTagFor) and this event's tag (eventTagFor), in BOTH tag systems
 * (contacts.tags text[] append-if-missing + contact_tags via
 * writeContactTag), using the CONTACT's own location_id (host-event
 * contacts live at the org master location post-HOST-MASTER.4; tags must
 * follow the contact, not the host). Tag writes are best-effort: a failure
 * is logged and swallowed, never thrown — this step must never turn a
 * host_contacts upsert success into a reported failure. If the host row
 * itself fails to load (transient error, or deleted between the earlier
 * host_id read and here), tagging is skipped entirely rather than
 * fabricating hostTagFor(null)'s fallback tag onto every attendee.
 * HOST-MASTER.5b batches a per-chunk contact_tags delta pre-check so a
 * steady-state re-confirmation (already tagged) costs ~1 query per 500
 * attendees instead of 2 idempotency SELECTs each.
 *
 * Callers hook this fire-and-forget after a registration flips to
 * 'confirmed' (race-payments free path + webhook path, the operator
 * manual-add) — each with its OWN try/catch, so a failure here can never
 * affect the payment/registration response. Errors THROW for those catchers
 * (race/registrations/host_contacts loads only — tagging never throws).
 *
 * HOST-CONSENT.1 — host marketing consent (host_contacts.marketing_consent)
 * is granted ONLY to the registrant of record whose own
 * race_registrations.marketing_consent is true (the checkbox only the
 * captain saw); team-mates get membership but never marketing consent, and
 * a NULL grants nothing — a pre-588 row, or a staff manual-add
 * (`/api/events/[id]/teams`) where nobody was shown the checkbox. A
 * contact already in host_email_suppressions for this host is also
 * skipped: a ticked box on a new registration does not re-open a prior
 * host unsubscribe (only a re-signup on /h/[slug], via resubscribeHost,
 * does).
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} raceEventId
 * @returns {Promise<number>} deduped contact count upserted (0 for no-op)
 */
export async function addEventAttendeesToHostList(db, raceEventId) {
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, host_id, slug, name')
    .eq('id', raceEventId)
    .maybeSingle()
  if (raceErr) throw new Error(`host contact list: race load failed: ${raceErr.message}`)
  if (!race || !race.host_id) return 0

  // Confirmed registrations → team members with a contact link. Mirrors
  // fetchEventAttendees' query shape (attendee-export.js) trimmed to the
  // contact ids, range-paginated past the 1k cap.
  const contactIds = new Set()
  const consentingIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, contact_id, marketing_consent, teams:team_id ( team_members ( contact_id ) )')
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
      // HOST-CONSENT.1 — only the registrant of record saw the checkbox.
      // Team-mates get membership (utility mail) but no marketing consent.
      // NULL = pre-588 registration: grants nothing (the backfill covered
      // those memberships once; anything later must come from a real tick).
      if (reg?.contact_id && reg.marketing_consent === true) consentingIds.add(reg.contact_id)
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

  // HOST-CONSENT.1 — a ticked box on a NEW registration does not re-open a
  // prior host unsubscribe (only a re-signup on /h/[slug] does, via
  // resubscribeHost). Skipping them keeps the audit trail honest: no
  // opt_in row for someone still suppressed.
  if (consentingIds.size > 0) {
    const { data: suppRows, error: suppErr } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', race.host_id)
      .in('contact_id', [...consentingIds])
    if (suppErr) throw new Error(`host contact list: suppressions query failed: ${suppErr.message}`)
    for (const row of suppRows || []) consentingIds.delete(row.contact_id)
  }

  // HOST-CONSENT.1 — grant host consent to the registrants who ticked the
  // box. Best-effort like tagging: membership is already durable. Wrapped in
  // try/catch so a transport throw (not just an { ok:false } result) cannot
  // abort the tagging block below.
  const consenting = [...consentingIds]
  try {
    for (let i = 0; i < consenting.length; i += UPSERT_CHUNK) {
      const r = await grantHostConsentBulk(db, { hostId: race.host_id, contactIds: consenting.slice(i, i + UPSERT_CHUNK), source: 'event_form' })
      if (!r.ok) logWarn('host-contact-list', 'host consent grant failed', { race_event_id: raceEventId, error: r.error })
    }
  } catch (err) {
    logWarn('host-contact-list', 'host consent grant threw', { race_event_id: raceEventId, err: err?.message || String(err) })
  }

  // HOST-MASTER.5 — tag each attendee to the host + this event, in BOTH tag
  // systems (subscribe-route pattern). writeContactTag fires tag_added
  // sequences, which cannot auto-enrol exempt contacts (enrolContacts gate).
  // Per-tag failures are logged and swallowed — attendance sync must never
  // fail because of a tag write.
  //
  // HOST-MASTER.5b — a failed (or TOCTOU-deleted) host load must NOT fall
  // back to hostTagFor(null)'s degenerate 'host:host' tag: that would
  // permanently mistag every attendee in both systems. Skip tagging
  // entirely rather than fabricate a host.
  const { data: host, error: hostErr } = await db
    .from('event_hosts')
    .select('id, slug, name')
    .eq('id', race.host_id)
    .maybeSingle()
  if (hostErr || !host) {
    logWarn('host-contact-list', 'host load failed — skipping attendee tagging', { err: hostErr, raceEventId })
    return rows.length
  }
  const tags = [hostTagFor(host), eventTagFor(race)]

  const idList = [...contactIds]
  for (let i = 0; i < idList.length; i += UPSERT_CHUNK) {
    const chunk = idList.slice(i, i + UPSERT_CHUNK)
    const { data: contactRows, error: contactsErr } = await db
      .from('contacts')
      .select('id, location_id, tags')
      .in('id', chunk)
    if (contactsErr) {
      logWarn('host-contact-list', 'attendee contacts load failed', { err: contactsErr })
      continue
    }

    // HOST-MASTER.5b — batched delta pre-check: a re-confirmation of an
    // already-tagged attendee is the steady-state case (every re-run of
    // this sync re-touches the same attendees), and writeContactTag's own
    // idempotency SELECT is per-(contact,tag) — O(2N) serial round-trips
    // on the payment-webhook thread otherwise. One query per chunk finds
    // which (contact, tag) pairs are already active; only the gaps go
    // through writeContactTag. Fail-open on error: writeContactTag is
    // idempotent on its own, so falling back to calling it for every pair
    // is merely slower, never incorrect.
    let alreadyTagged = new Set()
    try {
      const { data: existingTags, error: precheckErr } = await db
        .from('contact_tags')
        .select('contact_id, tag')
        .in('contact_id', chunk)
        .in('tag', tags)
        .is('removed_at', null)
      if (precheckErr) {
        logWarn('host-contact-list', 'tag delta pre-check failed — falling back to per-pair writes', { err: precheckErr })
      } else {
        alreadyTagged = new Set((existingTags || []).map((r) => `${r.contact_id}:${r.tag}`))
      }
    } catch (err) {
      logWarn('host-contact-list', 'tag delta pre-check failed — falling back to per-pair writes', { err })
    }

    for (const contact of contactRows || []) {
      const prior = Array.isArray(contact.tags) ? contact.tags : []
      const missing = tags.filter((t) => !prior.includes(t))
      if (missing.length > 0) {
        try {
          const { error } = await db
            .from('contacts')
            .update({ tags: [...new Set([...prior, ...missing])] })
            .eq('id', contact.id)
          if (error) {
            logWarn('host-contact-list', 'tag write failed', { err: error, contactId: contact.id, tags: missing })
          }
        } catch (err) {
          logWarn('host-contact-list', 'tag write failed', { err, contactId: contact.id, tags: missing })
        }
      }
      for (const tag of tags) {
        if (alreadyTagged.has(`${contact.id}:${tag}`)) continue
        try {
          await writeContactTag(db, { contactId: contact.id, locationId: contact.location_id, tag })
        } catch (err) {
          logWarn('host-contact-list', 'tag write failed', { err, contactId: contact.id, tag })
        }
      }
    }
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
 *   source:string, created_at:string, marketing_consent:boolean,
 *   emailable:boolean}>>}
 */
export async function fetchHostContactRows(db, hostId) {
  const memberships = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_contacts')
      .select(`
        contact_id, source, created_at, marketing_consent,
        contact:contacts!contact_id ( id, name, email, email_status, email_suppressed_at )
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
      marketing_consent: m.marketing_consent === true,
      emailable: isEmailable(contact, suppressedIds.has(m.contact_id), { hostConsent: m.marketing_consent === true }),
    }
  })
}
