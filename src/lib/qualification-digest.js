// src/lib/qualification-digest.js
//
// QUALS.1 — the weekly qualification digest to owners. An ARM of the daily
// 08:00 UTC cron /api/cron/contract-reminders, with its own heartbeat row
// ('qualification-digest', mig 635; src/lib/cron-arm-health.js).
//
// WHO. Per organisation, each ACTIVE, non-tombstoned profile that is `owner`
// at one of its studios, or a `master` holding a row there (the
// resolveRoleRecipientIds rule, src/lib/push.js, re-read here so a failed
// read throws instead of looking like "nobody to tell"). Their list covers
// the current people at THE STUDIOS WHERE THEY QUALIFY, and nobody else:
// an owner of Stillorgan never sees a Hatch-only coach, and nobody ever sees
// another organisation's people.
//
// WHAT. Records of ACTIVE types that are expired, or expire within 30 days,
// on the Dublin today (shared/qualifications.js digestRows). A missing record
// is not listed (it would nag forever); an archived type is not listed.
//
// WHEN. The cron runs daily. Each recipient gets at most one digest per
// Dublin week per organisation, on the first run of the week with something
// to say, normally Monday. A week with nothing due sends nothing.
//
// ONCE A WEEK, AND NEVER LOST (CLAUDE.md BAREWRITE (c)). notifyUsersOnce
// CLAIMS (key, recipient) in push_event_sends BEFORE it sends, and that claim
// has no lease: a process killed between the claim and the send would leave a
// claim with no digest behind it, and a weekly claim would swallow the whole
// week. So two keys, the AVAIL.1 shape (src/lib/availability-notify.js):
//   * the ATTEMPT key, qualification_digest:<org>:<Monday>:d<today>, is what
//     notifyUsersOnce claims. It dedups one day's run against a concurrent
//     re-invocation of the same cron, and it is fresh every day, so a dead
//     attempt is retried by the next day's run;
//   * the WEEK key, qualification_digest:<org>:<Monday>, is STAMPED into the
//     same ledger only AFTER a send that DELIVERED (a push sent, or a
//     fallback email accepted). The run reads the week's stamps first and
//     skips a recipient who has one.
// The price is a possible DUPLICATE (a digest that landed but whose stamp was
// lost is sent again the next day: counted in `stamp_failed`), never a loss.
// Nothing delivered (a failed push or email, a send that threw, no device and
// no email) is not stamped, so the next day tries again: at worst one attempt
// row a day for an owner who cannot be reached.
//
// QUIET HOURS (src/lib/staff-push-hours.js): nothing is planned, so nothing is
// claimed or stamped, unless the wall clock is inside [07:00, 22:00) at EVERY
// studio the recipient's list covers. 08:00 UTC is inside it all year in
// Dublin. Quiet hours gate the notice, never the state: a later run sends.
//
// HOW. notifyUsersOnce with category 'qualification_expiry' (registered:
// src/lib/qualification-expiry-registration.test.js): a push with the
// headline, and for a recipient with no device the registry's email fallback
// with the full list (payload.emailHtml).
//
// Throws on any read failure (the week's stamps included), BEFORE anything is
// sent; the cron records it and the heartbeat is not stamped. A per-recipient
// failure is counted in `failed` and never costs another recipient theirs.

import { notifyUsersOnce } from './push-dedup'
import { dublinDayStr, addDaysISO } from './dublin-time'
import { mondayOf } from './payroll'
import { inStaffPushHours, resolveStaffTimeZone } from './staff-push-hours'
import { isRosterableProfile } from './roster-write'
import { logWarn } from './log'
import {
  digestRows, digestHeadline, formatQualificationDate, QUALIFICATION_EXPIRY_WINDOW_DAYS,
} from '@shared/qualifications'

export const QUALIFICATION_DIGEST_CATEGORY = 'qualification_expiry'
export const QUALIFICATION_DIGEST_TYPE = 'qualification_digest'

const PAGE = 1000

/** The WEEK key: stamped after a delivered send; one digest per recipient per org per Dublin week. */
export const digestEventKey = (organizationId, weekStart) => `qualification_digest:${organizationId}:${weekStart}`
/** The ATTEMPT key notifyUsersOnce claims: fresh each Dublin day, so a dead attempt is retried tomorrow. */
export const digestAttemptKey = (organizationId, weekStart, todayISO) =>
  `${digestEventKey(organizationId, weekStart)}:d${todayISO}`

const isRecipientLink = (l) => isRosterableProfile(l?.profiles) && (l.role === 'owner' || l.profiles.role === 'master')

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** The fallback email's body: the headline and one row per record. */
export function digestEmailHtml({ orgName = '', headline = '', rows = [] } = {}) {
  const cell = 'padding:6px 8px;border-bottom:1px solid #eee;text-align:left'
  const items = rows.map((r) => `<tr><td style="${cell}">${esc(r.full_name || 'Someone')}</td><td style="${cell}">${esc(r.type_name)}</td><td style="${cell}">${r.status === 'expired' ? 'Expired' : 'Expires'} ${esc(formatQualificationDate(r.expires_on))}</td></tr>`).join('')
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="font-size:18px;margin:0 0 12px 0">Qualifications to renew${orgName ? ` at ${esc(orgName)}` : ''}</h2>
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px 0">${esc(headline)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">${items}</table>
      <p style="margin-top:24px;font-size:12px;color:#666">Update a record under Schedule, Qualifications on the web once it is renewed. You get this summary at most once a week, and only when something needs attention. It came by email because the Repset app is not set up on your phone.</p>
    </div>
  `
}

/**
 * PURE. Who gets a digest this run, with what.
 * @returns {{ plans: Array<{ recipientId, organizationId, eventKey, attemptKey, rows, payload }>,
 *   recipients: number, nothing_due: number, quiet_hours: number, timezoneFallbackLocationIds: string[] }}
 */
export function planQualificationDigests({
  locations = [], organizations = [], links = [], types = [], records = [], todayISO, nowMs,
  windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS,
} = {}) {
  const out = { plans: [], recipients: 0, nothing_due: 0, quiet_hours: 0, timezoneFallbackLocationIds: [] }
  const weekStart = mondayOf(todayISO)
  const locById = new Map(locations.filter((l) => l?.id && l.organization_id).map((l) => [l.id, l]))
  const orgNames = new Map(organizations.map((o) => [o.id, o.name]))

  const members = new Map() // location id → Map(profile id → full name)
  const qualifying = new Map() // `${org}|${profile}` → Set(location ids where they receive)
  for (const l of links) {
    const loc = locById.get(l?.location_id)
    if (!loc || !l.profile_id || !isRosterableProfile(l.profiles)) continue
    if (!members.has(loc.id)) members.set(loc.id, new Map())
    members.get(loc.id).set(l.profile_id, l.profiles.full_name ?? null)
    if (isRecipientLink(l)) {
      const key = `${loc.organization_id}|${l.profile_id}`
      if (!qualifying.has(key)) qualifying.set(key, new Set())
      qualifying.get(key).add(loc.id)
    }
  }

  const warned = new Set()
  for (const [key, locIds] of [...qualifying.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [organizationId, recipientId] = key.split('|')
    out.recipients++
    const people = new Map()
    for (const locId of locIds) for (const [pid, name] of members.get(locId) || []) people.set(pid, name)
    const rows = digestRows({
      people: [...people].map(([profile_id, full_name]) => ({ profile_id, full_name })),
      types: types.filter((t) => t.organization_id === organizationId),
      records: records.filter((r) => r.organization_id === organizationId),
      todayISO,
      windowDays,
    })
    if (rows.length === 0) {
      out.nothing_due++
      continue
    }

    let open = true
    for (const locId of [...locIds].sort()) {
      const { timeZone, warn } = resolveStaffTimeZone(locById.get(locId)?.timezone)
      if (warn && !warned.has(locId)) {
        warned.add(locId)
        out.timezoneFallbackLocationIds.push(locId)
      }
      if (!inStaffPushHours(nowMs, timeZone)) open = false
    }
    if (!open) {
      out.quiet_hours++
      continue
    }

    const orgName = orgNames.get(organizationId) || ''
    const headline = digestHeadline(rows, windowDays)
    out.plans.push({
      recipientId,
      organizationId,
      eventKey: digestEventKey(organizationId, weekStart),
      attemptKey: digestAttemptKey(organizationId, weekStart, todayISO),
      rows,
      payload: {
        title: 'Qualifications to renew',
        body: `${headline} The list is under Schedule, Qualifications on the web.`,
        category: QUALIFICATION_DIGEST_CATEGORY,
        // The registry's fallbackEmail is on; notifyUsers prefers these.
        emailSubject: orgName ? `Qualifications to renew at ${orgName}` : 'Qualifications to renew',
        emailHtml: digestEmailHtml({ orgName, headline, rows }),
        data: { type: QUALIFICATION_DIGEST_TYPE, organization_id: organizationId, week_start: weekStart },
      },
    })
  }
  return out
}

async function readPaged(label, build) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build().range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${label} read failed: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function readOnce(label, query) {
  const { data, error } = await query
  if (error) throw new Error(`${label} read failed: ${error.message}`)
  return data || []
}

/**
 * Recipients already stamped with this week's digest: a Set of
 * `${event_key}|${recipient_id}`. Throws on a failed read (before any send).
 */
async function readWeekStamps(db, eventKeys) {
  if (!eventKeys.length) return new Set()
  const rows = await readPaged('push_event_sends', () => db
    .from('push_event_sends')
    .select('id, event_key, recipient_id')
    .in('event_key', eventKeys)
    .order('id', { ascending: true }))
  return new Set(rows.map((r) => `${r.event_key}|${r.recipient_id}`))
}

// Stamp the week ONLY when something reached the person: a push sent or a
// fallback email accepted, and the attempt was ours (not deduped against a
// concurrent run holding today's attempt claim, which stamps for itself).
// Anything else (a failed email fallback, a send that threw inside
// push-dedup, no device and no email) leaves the week open: the cost is one
// harmless attempt row a day for an owner who cannot be reached, never a
// lost week (QUALS.1 review).
function delivered(r) {
  if (!r || (r.deduped || 0) > 0) return false
  return (r.sent || 0) > 0 || (r.emailed || 0) > 0
}

/**
 * @param {object} db  service-role supabase client
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ organizations, recipients, rows, nothing_due, quiet_hours, sent, emailed, email_failed, deduped, failed, stamp_failed }>}
 *   throws when a read fails, before anything is sent
 */
export async function runQualificationDigest(db, { nowMs = Date.now() } = {}) {
  const outcome = {
    organizations: 0, recipients: 0, rows: 0, nothing_due: 0, quiet_hours: 0,
    sent: 0, emailed: 0, email_failed: 0, deduped: 0, failed: 0, stamp_failed: 0,
  }
  const todayISO = dublinDayStr(nowMs)

  const locations = await readOnce('locations', db
    .from('locations')
    .select('id, name, organization_id, timezone')
    .eq('active', true)
    .eq('is_host_anchor', false))
  const orgIds = [...new Set(locations.map((l) => l.organization_id).filter(Boolean))]
  outcome.organizations = orgIds.length
  if (orgIds.length === 0) return outcome
  const locIds = locations.map((l) => l.id)

  const [organizations, links, types, records] = await Promise.all([
    readOnce('organizations', db.from('organizations').select('id, name').in('id', orgIds)),
    readPaged('profile_locations', () => db
      .from('profile_locations')
      .select('profile_id, location_id, role, profiles!inner(id, full_name, role, active, deleted_at)')
      .in('location_id', locIds)
      .order('profile_id', { ascending: true })
      .order('location_id', { ascending: true })),
    readOnce('qualification types', db
      .from('staff_qualification_types')
      .select('id, organization_id, name, active')
      .in('organization_id', orgIds)
      .eq('active', true)),
    readPaged('qualifications', () => db
      .from('staff_qualifications')
      .select('id, organization_id, profile_id, qualification_type_id, expires_on')
      .in('organization_id', orgIds)
      .not('expires_on', 'is', null)
      .lte('expires_on', addDaysISO(todayISO, QUALIFICATION_EXPIRY_WINDOW_DAYS))
      .order('id', { ascending: true })),
  ])

  const planned = planQualificationDigests({ locations, organizations, links, types, records, todayISO, nowMs })
  outcome.recipients = planned.recipients
  outcome.nothing_due = planned.nothing_due
  outcome.quiet_hours = planned.quiet_hours
  if (planned.timezoneFallbackLocationIds.length) {
    logWarn('qualification-digest', 'invalid timezone on a location: using Europe/Dublin for it', { locationIds: planned.timezoneFallbackLocationIds })
  }
  if (planned.plans.length === 0) return outcome

  // The week's stamps, read BEFORE anything is sent (a failure throws here).
  const stamped = await readWeekStamps(db, [...new Set(planned.plans.map((pl) => pl.eventKey))])

  for (const plan of planned.plans) {
    if (stamped.has(`${plan.eventKey}|${plan.recipientId}`)) {
      outcome.deduped++
      continue
    }
    outcome.rows += plan.rows.length
    let r = null
    try {
      r = await notifyUsersOnce(db, plan.attemptKey, [plan.recipientId], plan.payload)
    } catch (err) {
      // notifyUsersOnce is documented never to throw; if it does, one
      // recipient's failure must not cost the next one theirs. Not stamped:
      // the next day's run retries.
      outcome.failed++
      logWarn('qualification-digest', 'send failed for a recipient', { recipientId: plan.recipientId, err: err?.message })
      continue
    }
    outcome.sent += r?.sent || 0
    outcome.emailed += r?.emailed || 0
    outcome.email_failed += r?.email_failed || 0
    outcome.deduped += r?.deduped || 0
    outcome.failed += r?.failed || 0
    if (!delivered(r)) continue

    // The week's stamp, AFTER the send. Lost = a duplicate tomorrow, never a loss.
    const { error: stampErr } = await db
      .from('push_event_sends')
      .upsert({ event_key: plan.eventKey, recipient_id: plan.recipientId }, { onConflict: 'event_key,recipient_id', ignoreDuplicates: true })
    if (stampErr) {
      outcome.stamp_failed++
      logWarn('qualification-digest', 'week stamp failed: the next run may send this digest again', {
        recipientId: plan.recipientId, eventKey: plan.eventKey, err: stampErr.message,
      })
    }
  }
  return outcome
}
