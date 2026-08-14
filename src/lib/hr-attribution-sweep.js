// ATTR-3 — the IO half of the attribution canary + weekly metric. Decisions
// live in src/lib/hr-attribution-health.js; this loads, counts and sends.
//
// Daily (every run): find today's attribution breaks — registered straps
// worn in class whose owner got no session — and raise one ops alert per
// affected location. Zero registrations or zero qualifying visits = clean
// no-op; the canary is structurally incapable of firing on an empty room.
//
// Weekly (Sunday runs, Dublin): the attribution scorecard for the week just
// ending — attributed sessions vs the freeze target, who claimed, what is
// still landing anonymous — mailed via the same ops-alert rail.

import { dublinDayRangeMs, dublinWeekStartMs, dublinDateKey, dublinAddDays } from '@/lib/dublin-time'
import { findAttributionBreaks, assessFreezeGate, FREEZE_TARGET_PER_WEEK } from '@/lib/hr-attribution-health'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { logInfo, logWarn } from '@/lib/log'

// Bounded reads: a location's realistic daily ceiling is ~30 straps × ~10
// classes of visits; 1000 leaves an order of magnitude of headroom while
// respecting the PostgREST cap. If a day ever genuinely exceeds it we would
// rather under-check than page an unbounded sweep at 21:45.
const ROW_CAP = 1000

/** Sunday in Dublin — the weekly report covers Mon..Sun and runs as the week ends. */
export function isDublinSunday(nowMs) {
  const key = dublinDateKey(nowMs)
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0
}

async function loadActiveRegistrations(db) {
  const { data, error } = await db
    .from('contact_devices')
    .select('identifier, contact_id, created_at, added_by_contact')
    .eq('is_active', true)
    .limit(ROW_CAP)
  if (error) throw new Error(`contact_devices read failed: ${error.message}`)
  return data || []
}

async function runDailyCanary(db, { nowMs, dry }) {
  const registrations = await loadActiveRegistrations(db)
  if (registrations.length === 0) return { checked: 0, breaks: [], skipped: 'no-registrations' }

  const todayKey = dublinDateKey(nowMs)
  const { startMs, endMs } = dublinDayRangeMs(todayKey, todayKey)
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()

  const { data: visits, error: vErr } = await db
    .from('hr_detection_visits')
    .select('device_key, location_id, started_at, last_sample_at, sample_count, class_name, glofox_event_id')
    .gte('last_sample_at', startIso)
    .lt('started_at', endIso)
    .limit(ROW_CAP)
  if (vErr) throw new Error(`hr_detection_visits read failed: ${vErr.message}`)

  const { data: sessions, error: sErr } = await db
    .from('heart_rate_sessions')
    .select('contact_id, device_identifier, started_at, ended_at, location_id')
    .gte('started_at', startIso)
    .lt('started_at', endIso)
    .limit(ROW_CAP)
  if (sErr) throw new Error(`heart_rate_sessions read failed: ${sErr.message}`)

  const breaks = findAttributionBreaks({ visits, registrations, sessions })
  if (breaks.length === 0 || dry) return { checked: visits?.length ?? 0, breaks }

  // One alert per location, not per break — a broken router affects every
  // strap at once and thirty emails saying so is one email's information.
  const byLocation = new Map()
  for (const b of breaks) {
    if (!byLocation.has(b.location_id)) byLocation.set(b.location_id, [])
    byLocation.get(b.location_id).push(b)
  }
  for (const [locationId, locBreaks] of byLocation) {
    const { data: loc } = await db
      .from('locations').select('name, organization_id').eq('id', locationId).maybeSingle()
    const rows = locBreaks.map((b) =>
      `<li><code>${b.device_key}</code> — ${b.sample_count} samples during ${b.class_name || 'a class'}, ` +
      (b.reason === 'anon_session'
        ? 'landed in an ANONYMOUS session (the router ignored an active registration)'
        : 'produced no session for its owner at all') + '</li>').join('')
    await sendOpsAlert({
      organizationId: loc?.organization_id,
      locationId,
      subject: `HR attribution broke today at ${loc?.name || 'a studio'} (${locBreaks.length} strap${locBreaks.length === 1 ? '' : 's'})`,
      htmlBody: `
        <p>A registered strap was worn during class and its owner did not get the session.
        Capture worked (the samples were seen); the strap→member link did not.</p>
        <ul>${rows}</ul>
        <p>Likely suspects: auto-association (mig 112) in resolveStrapsForBatch, or an
        inactive/duplicated contact_devices row. The registrations these straps carry
        were active at check time.</p>`,
      pushBody: `HR attribution broke for ${locBreaks.length} registered strap(s) today`,
    }, { db })
  }
  return { checked: visits?.length ?? 0, breaks, alerted: byLocation.size }
}

async function countWeek(db, weekStartMs, weekEndMs) {
  const startIso = new Date(weekStartMs).toISOString()
  const endIso = new Date(weekEndMs).toISOString()

  const { data: sessions, error } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id')
    .eq('source', 'ble_bridge')
    .gte('started_at', startIso)
    .lt('started_at', endIso)
    .limit(ROW_CAP)
  if (error) throw new Error(`weekly sessions read failed: ${error.message}`)

  const attributedRows = (sessions || []).filter((s) => s.contact_id != null)
  const { count: samples } = await db
    .from('hr_samples')
    .select('id', { count: 'exact', head: true })
    .gte('recorded_at', startIso)
    .lt('recorded_at', endIso)

  const { data: regs, error: rErr } = await db
    .from('contact_devices')
    .select('id, added_by_contact')
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .limit(ROW_CAP)
  if (rErr) throw new Error(`weekly registrations read failed: ${rErr.message}`)

  return {
    attributed: attributedRows.length,
    members: new Set(attributedRows.map((s) => s.contact_id)).size,
    anonSessions: (sessions || []).length - attributedRows.length,
    samples: samples ?? 0,
    newRegistrations: (regs || []).length,
    memberClaims: (regs || []).filter((r) => r.added_by_contact).length,
  }
}

async function runWeeklyReport(db, { nowMs, dry }) {
  // The report runs on Sunday evening, so "this week" = the Monday just gone
  // through now; "last week" = the seven days before that Monday.
  const weekStartMs = dublinWeekStartMs(nowMs)
  const prevWeekStartMs = dublinWeekStartMs(weekStartMs - 1)
  const current = await countWeek(db, weekStartMs, nowMs)
  const previous = await countWeek(db, prevWeekStartMs, weekStartMs)

  const registrations = await loadActiveRegistrations(db)
  current.activeDevices = registrations.length

  const gate = assessFreezeGate({ current, previous })
  if (dry) return { current, previous, gate }

  // One report per organization that operates a bridge — today that is one.
  const { data: bridges, error: bErr } = await db
    .from('ble_bridges').select('location_id, locations(name, organization_id)').limit(50)
  if (bErr) throw new Error(`ble_bridges read failed: ${bErr.message}`)
  const orgs = new Map()
  for (const b of bridges || []) {
    const orgId = b.locations?.organization_id
    if (orgId && !orgs.has(orgId)) orgs.set(orgId, b.location_id)
  }

  const weekLabel = `${dublinDateKey(weekStartMs)} – ${dublinAddDays(dublinDateKey(weekStartMs), 6)}`
  for (const [organizationId, locationId] of orgs) {
    await sendOpsAlert({
      organizationId,
      locationId,
      subject: `HR attribution this week: ${current.attributed} attributed session${current.attributed === 1 ? '' : 's'} (target ${FREEZE_TARGET_PER_WEEK})`,
      htmlBody: `
        <p><strong>${gate.statusLine}</strong></p>
        <ul>
          <li>Attributed sessions: <strong>${current.attributed}</strong> (last week ${previous.attributed})</li>
          <li>Members with real HR data: <strong>${current.members}</strong></li>
          <li>Still landing anonymous: ${current.anonSessions} session${current.anonSessions === 1 ? '' : 's'}</li>
          <li>Samples captured: ${current.samples.toLocaleString('en-IE')}</li>
          <li>New registrations: ${current.newRegistrations} (${current.memberClaims} claimed by members, ${current.newRegistrations - current.memberClaims} by coaches)</li>
          <li>Active registered devices: ${current.activeDevices}</li>
        </ul>
        <p>Week ${weekLabel}. Anonymous sessions are straps worn by members who have not
        claimed them yet — each one is a coach tap on the Detected tab away from counting.</p>`,
      pushBody: `HR week: ${current.attributed} attributed (target ${FREEZE_TARGET_PER_WEEK}), ${current.newRegistrations} new registrations`,
    }, { db })
  }
  return { current, previous, gate, reported: orgs.size }
}

/**
 * Entry point for the cron route. Never throws for per-section failures —
 * the canary failing must not eat the weekly report or vice versa; each
 * section reports its own error and the route decides the heartbeat.
 */
export async function runAttributionHealthSweep({ db, nowMs = Date.now(), dry = false, forceWeekly = false }) {
  const out = { ok: true }
  try {
    out.daily = await runDailyCanary(db, { nowMs, dry })
  } catch (e) {
    out.ok = false
    out.daily = { error: e?.message || String(e) }
    logWarn('hr-attribution', 'daily canary failed', { err: out.daily.error })
  }
  if (forceWeekly || isDublinSunday(nowMs)) {
    try {
      out.weekly = await runWeeklyReport(db, { nowMs, dry })
    } catch (e) {
      out.ok = false
      out.weekly = { error: e?.message || String(e) }
      logWarn('hr-attribution', 'weekly report failed', { err: out.weekly.error })
    }
  }
  logInfo('hr-attribution', 'sweep done', {
    breaks: out.daily?.breaks?.length ?? null, weekly: Boolean(out.weekly), dry,
  })
  return out
}
