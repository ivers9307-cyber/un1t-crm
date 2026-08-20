// FLEET-ALERT.1 — every 5 min: notice when a gym Pi goes dark, and say so.
//
// WHY THIS EXISTS
// The Stillorgan heart-rate bridge died on 2026-07-16 and nobody noticed for
// 17 days. Across that window the system created 1,186 heart-rate sessions
// containing zero samples. Two failures had to coincide: the admin badge said
// ONLINE (fixed in BRIDGE-STATUS.1 / #1193), and nothing shouted. Fixing the
// badge only helps someone who goes and looks — nobody did. This is the part
// that shouts.
//
// TWO SIGNALS, because either alone misses a real failure:
//
//   reachability — Tailscale's connectedToControl. Whole-fleet coverage with
//                  ZERO device-side code, including the two kiosk Pis driving
//                  the wall TVs, which report nothing to the CRM at all and
//                  are otherwise invisible to every surface the business has.
//
//   service      — deriveBridgeStatus() over the ble_bridges row, for bridges.
//                  On 2026-08-02 a freshly provisioned Pi joined the tailnet,
//                  answered SSH and reported cloud-init done — with no bridge
//                  installed. Reachability alone calls that healthy.
//
//   BRIDGE-BLIND.1 adds the third: is the bridge READING anything? On
//                  2026-08-12 the Stillorgan bridge heartbeated healthily for
//                  2.5 hours across two full classes and ingested zero
//                  samples — ANT+ scanner wedged, BLE radio never powered
//                  (noble came up `unauthorized`). Both signals above said
//                  healthy, and both were telling the truth. `adapter_down`
//                  reads the telemetry the bridge was already sending (mig
//                  531); `blind` notices a class running with no samples
//                  landing. See src/lib/fleet-health.js for why they are two
//                  grades of different strength rather than one.
//
//   BRIDGE-UNDELIVERED.1 adds the fourth, and the only one every signal above
//                  calls healthy: the bridge is reachable, heartbeating and
//                  reading straps, but the readings are stacking up in its
//                  local buffer instead of arriving. It self-reports that
//                  queue on each heartbeat; mig 538's `pending_stuck_since`
//                  marker is what turns a historyless number into "for how
//                  long". Unlike the others it runs against a deadline — the
//                  bridge drops the oldest sample once its 5,000-slot buffer
//                  fills — so it outranks both grades above.
//
// Reusing deriveBridgeStatus (shipped in #1193) means this alert, the admin
// badge and the TV connection dot cannot disagree with each other.
//
// SHIPS DARK. With TAILSCALE_OAUTH_* unset the route no-ops and still stamps
// its heartbeat, so merging changes nothing until it is configured.
//
// Spec: docs/superpowers/specs/2026-08-02-fleet-health-alerting-design.md

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logInfo, logWarn, logError } from '@/lib/log'
import { sendEmail } from '@/lib/postmark'
import { sendPush } from '@/lib/push'
import { getAppUrl } from '@/lib/app-url'
import { listTailnetDevices, tailscaleConfigured } from '@/lib/tailscale-api'
import {
  isFleetDevice,
  deviceNameOf,
  gradeDevice,
  decideAlert,
  indexBridgesByDevice,
  locationsNeedingVisibilityProbe,
  CLASS_GRACE_MS,
  SAMPLE_SILENCE_MS,
  SESSION_LOOKBACK_MS,
} from '@/lib/fleet-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Dormant until configured. The heartbeat still stamps, so cron_health
  // does not report this as stale merely for being unconfigured.
  if (!tailscaleConfigured()) {
    await stampHeartbeat('fleet-health', { configured: false })
    return NextResponse.json({ success: true, data: { configured: false, checked: 0 } })
  }

  const db = createServerClient()
  const now = Date.now()

  let devices
  try {
    devices = await listTailnetDevices()
  } catch (err) {
    // A Tailscale outage is not a fleet outage. Do NOT alert — an API failure
    // would otherwise page for all six devices at once, which is exactly the
    // cry-wolf behaviour that gets alerting muted. Skip the heartbeat too, so
    // a persistently broken integration surfaces as a stale cron.
    logError('fleet-health', 'tailscale api unreachable', { err: String(err) })
    return NextResponse.json({ success: false, error: 'tailscale_unreachable' }, { status: 200 })
  }

  const fleet = devices.filter(isFleetDevice)
  if (fleet.length === 0) {
    // No tagged devices at all is more likely a mis-scoped OAuth client or a
    // wrong tailnet than six simultaneously destroyed Pis. Say so rather than
    // alerting.
    logWarn('fleet-health', 'no devices carry the fleet tag', { seen: devices.length })
    await stampHeartbeat('fleet-health', { configured: true, checked: 0, tagged: 0 })
    return NextResponse.json({ success: true, data: { checked: 0, tagged: 0 } })
  }

  // Bridges keyed by the Tailscale device they run on — see
  // indexBridgesByDevice for why that link is an explicit column (mig 473) and
  // not hardware_id. A device with no matching row is graded on reachability
  // alone, which is the correct behaviour for the two kiosk Pis.
  //
  // BRIDGE-BLIND.1 pulls four more columns: location_id (to look up what is
  // scheduled in that room), the two adapter flags, and last_seen_straps —
  // which costs nothing here (mig 111, already a single jsonb overwrite) and
  // turns "0 samples" into an alert line that says whether the bridge could
  // see any straps at all.
  //
  // BRIDGE-UNDELIVERED.1 pulls two more: `pending_stuck_since` (mig 538) and
  // `last_pending_samples`. Both are required — the marker says how long the
  // bridge has been holding samples, the count says whether it is a genuine
  // backlog or an ordinary flush in progress, and the grade needs both. Adding
  // a column to a select that already reads the row is free; forgetting one
  // would make undeliveredDetail silently unable to fire, which is precisely
  // the dead-signal class this whole line of work exists to end.
  const { data: bridgeRows } = await db
    .from('ble_bridges')
    .select('id, name, hardware_id, tailscale_hostname, status, last_seen_at, location_id, last_ant_ok, last_ble_ok, last_telemetry_at, last_seen_straps, pending_stuck_since, last_pending_samples')
  const bridgeByName = indexBridgesByDevice(bridgeRows)

  const names = fleet.map(deviceNameOf).filter(Boolean)

  // FLEET-CMD.1 — register anything new before touching health.
  //
  // fleet_device_health now carries a foreign key to fleet_devices (mig 474),
  // so the parent row has to exist or the upsert below fails. Auto-registering
  // is deliberate: Tailscale is where a newly provisioned Pi shows up first,
  // and the alternative — skipping devices nobody has claimed yet — would mean
  // a Pi silently going unmonitored, which is precisely the 17-day failure
  // this cron exists to prevent.
  //
  // ignoreDuplicates so this never clobbers the location_id, role or label an
  // admin has set. A newly discovered device lands unclaimed (both NULL),
  // which the page shows as "needs a home" and which offers no actions.
  if (names.length) {
    const { error: regError } = await db
      .from('fleet_devices')
      .upsert(names.map((device_name) => ({ device_name })), {
        onConflict: 'device_name',
        ignoreDuplicates: true,
      })
    if (regError) {
      // Without the parent rows the health upsert would fail the FK for every
      // device, so stop rather than press on and lose the whole tick's state.
      logError('fleet-health', 'failed to register devices', { err: regError })
      return NextResponse.json({ success: false, error: 'register_failed' }, { status: 200 })
    }
  }

  const { data: priorRows } = await db
    .from('fleet_device_health')
    .select('device_name, state, state_since, alerted_at, suppressed_until')
    .in('device_name', names)
  const priorByName = new Map((priorRows || []).map((r) => [r.device_name, r]))

  // FLEET-CMD.2 — the render heartbeat, so a kiosk showing a black screen
  // stops grading `ok`. Read after the auto-register above, so a device
  // discovered on this very tick is present (with a null render time, which
  // correctly grades on reachability alone).
  const { data: fleetRows } = await db
    .from('fleet_devices')
    .select('device_name, role, last_render_at')
    .in('device_name', names)
  const fleetByName = new Map((fleetRows || []).map((r) => [r.device_name, r]))

  // BRIDGE-BLIND.1 — what is happening in each bridge's room right now.
  //
  // Only for locations whose bridge could plausibly grade `blind` (see
  // locationsNeedingVisibilityProbe): an unreachable, silent, or
  // admittedly-radio-dead bridge already has a truthful, higher-ranking grade,
  // so asking the database about it would be work for nothing. In practice
  // that is at most one location today.
  const visibilityByLocation = await readVisibility(
    db, locationsNeedingVisibilityProbe(fleet, bridgeByName, now), now,
  )

  const alerts = []
  const rows = []

  for (const device of fleet) {
    const name = deviceNameOf(device)
    if (!name) continue
    const bridgeRow = bridgeByName.get(name) ?? null
    // A location absent from the map (probe skipped or failed) yields
    // undefined -> null, and gradeDevice then never considers `blind`. Failing
    // open is the rule here: an unknown must not end in an alert.
    const visibility = bridgeRow?.location_id
      ? (visibilityByLocation.get(bridgeRow.location_id) ?? null)
      : null
    const graded = gradeDevice(device, bridgeRow, now, fleetByName.get(name) ?? null, visibility)
    const { alert, row } = decideAlert(graded, priorByName.get(name) ?? null, now)
    rows.push(row)
    if (alert) alerts.push({ ...graded, alert, row })
  }

  if (alerts.length) {
    // Notify BEFORE persisting, because `alerted_at` is a claim that someone
    // was told. Stamping it first and then failing to send would suppress
    // every future alert for that outage — the cron would sit there believing
    // it had done its job. So an undelivered alert rolls the stamp back to
    // whatever it was, and the next tick (5 min) tries again.
    //
    // Notifying must also never fail the run: the per-recipient sends swallow
    // their own errors, but getAppUrl() throws when unset and the profiles
    // read can fail. An uncaught throw here would skip the heartbeat and hide
    // the failure of the thing that exists to stop failures hiding.
    let delivered = false
    try {
      delivered = await notify(db, alerts)
    } catch (err) {
      logError('fleet-health', 'failed to notify', { err: String(err), count: alerts.length })
    }

    if (delivered) {
      logInfo('fleet-health', 'alerts sent', {
        count: alerts.length,
        alerts: alerts.map((a) => `${a.name}:${a.alert}`),
      })
    } else {
      logError('fleet-health', 'alert reached nobody — will retry next tick', {
        alerts: alerts.map((a) => `${a.name}:${a.alert}`),
      })
      // Re-arming differs by direction, and getting it wrong loses the alert.
      // A failed DOWN notice needs alerted_at null, because the next tick sees
      // an unchanged state and only re-alerts when nothing has been sent.
      // A failed RECOVERY notice needs the OLD outage stamp back, because a
      // recovery is announced only when a previous alert is on record —
      // nulling it would make the device look like it had never been down.
      for (const a of alerts) {
        a.row.alerted_at = a.alert === 'recovered'
          ? (priorByName.get(a.name)?.alerted_at ?? null)
          : null
      }
    }
  }

  if (rows.length) {
    const { error } = await db.from('fleet_device_health').upsert(rows, { onConflict: 'device_name' })
    if (error) logWarn('fleet-health', 'failed to persist device state', { err: error })
  }

  // FLEET-CMD.1 — bury commands that were never delivered.
  //
  // The agent checks expiry itself before executing, so this is tidying rather
  // than enforcement: it exists so the UI can say "not delivered — the Pi was
  // offline" instead of leaving a row sitting at 'pending' forever, looking
  // like something that might still happen.
  //
  // Riding this cron rather than adding one: it is a 5-minute sweep of a table
  // with single-digit rows, and a new vercel.json entry would need its own
  // heartbeat row and its own way to go stale.
  const expired = await expireStaleCommands(db)

  // FLEET-CMD.3 — screenshots are not an archive.
  //
  // A board capture holds member first names and live BPM. It exists to answer
  // "what is on that screen right now"; a day later it answers nothing and is
  // purely a liability. Pruning here rather than on a lifecycle rule keeps the
  // retention visible in the codebase, where a reviewer will see it.
  const pruned = await pruneScreenshots(db)

  await stampHeartbeat('fleet-health', {
    configured: true,
    checked: rows.length,
    alerted: alerts.length,
    expired,
    pruned,
  })

  return NextResponse.json({
    success: true,
    data: { checked: rows.length, alerted: alerts.length, expired, pruned },
  })
}

/**
 * BRIDGE-BLIND.1 — is a class running at this location, and has any heart-rate
 * data landed lately?
 *
 * Read as two cheap, independent facts and handed to the pure grader; no
 * judgement is made here. A THROWN error means "we do not know", and the
 * caller drops the location from the map so gradeDevice never considers the
 * blind grade for it. Silence on unknown is the whole discipline: this cron
 * exists because nobody noticed a failure, and it stays useful only for as
 * long as its alerts are believed.
 *
 * @returns {Promise<{ classNow: object|null, sampleCount: number|null }>}
 */
async function visibilityForLocation(db, locationId, nowMs) {
  const nowIso = new Date(nowMs).toISOString()

  // The class in progress. `cancelled_at is null` matters — a cancelled class
  // still sits in the mirror (mig 344) and an empty room is not a fault.
  const { data: occurrences, error: occError } = await db
    .from('class_occurrences')
    .select('name, program, starts_at, ends_at')
    .eq('location_id', locationId)
    .is('cancelled_at', null)
    .lte('starts_at', nowIso)
    .gt('ends_at', nowIso)
    .order('starts_at', { ascending: false })
    .limit(1)
  if (occError) throw new Error(`class_occurrences: ${occError.message}`)

  const classNow = occurrences?.[0] ?? null
  if (!classNow) return { classNow: null, sampleCount: null }

  // Don't pay for the sample count until the class is far enough in for the
  // answer to matter. blindDetail() re-checks the grace itself — this is the
  // cheap short-circuit, not the rule.
  const startMs = Date.parse(classNow.starts_at ?? '')
  if (!Number.isFinite(startMs) || nowMs - startMs < CLASS_GRACE_MS) {
    return { classNow, sampleCount: null }
  }

  // hr_samples carries no location — it hangs off heart_rate_sessions — so
  // resolve the location's recent BRIDGE sessions first. Restricted to
  // source='ble_bridge' on purpose: an Apple Health or Whoop sync landing
  // samples for the same room would be perfectly real data that says nothing
  // about whether the Pi is reading straps.
  const { data: sessions, error: sessionError } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('location_id', locationId)
    .eq('source', 'ble_bridge')
    .gte('started_at', new Date(nowMs - SESSION_LOOKBACK_MS).toISOString())
    .limit(500)
  if (sessionError) throw new Error(`heart_rate_sessions: ${sessionError.message}`)

  const ids = (sessions || []).map((s) => s.id).filter(Boolean)
  // No bridge session at all this class means no strap ever reported, which at
  // this studio is the ORDINARY case (see priorCount below) — not a fault.
  if (ids.length === 0) return { classNow, sampleCount: 0, priorCount: 0 }

  const { count, error: countError } = await db
    .from('hr_samples')
    .select('session_id', { count: 'exact', head: true })
    .in('session_id', ids)
    .gte('recorded_at', new Date(nowMs - SAMPLE_SILENCE_MS).toISOString())
  if (countError) throw new Error(`hr_samples: ${countError.message}`)
  // A count-only select that comes back without a number is an unknown, not a
  // zero. Treating it as zero would invent an outage out of a PostgREST quirk.
  if (!Number.isFinite(count)) return { classNow, sampleCount: null, priorCount: null }

  // Samples EARLIER in this same class — from its start up to the silence
  // window. This is what turns the blind grade from "nobody is wearing a
  // strap" (ordinary here: 14-day measurement on 2026-08-12 found only 17 of
  // 84 classes had ANY strap, so ~80% of classes legitimately report zero)
  // into "straps were reporting in THIS class and then stopped", which is the
  // actual signature of a wedged scanner and cannot happen in an empty room.
  const { count: prior, error: priorError } = await db
    .from('hr_samples')
    .select('session_id', { count: 'exact', head: true })
    .in('session_id', ids)
    .gte('recorded_at', new Date(startMs).toISOString())
    .lt('recorded_at', new Date(nowMs - SAMPLE_SILENCE_MS).toISOString())
  if (priorError) throw new Error(`hr_samples prior: ${priorError.message}`)

  return {
    classNow,
    sampleCount: count,
    priorCount: Number.isFinite(prior) ? prior : null,
  }
}

/**
 * Probe every candidate location, tolerating failure per location.
 * A location that throws is simply absent from the map — see above.
 */
async function readVisibility(db, locationIds, nowMs) {
  const byLocation = new Map()
  for (const locationId of locationIds) {
    try {
      byLocation.set(locationId, await visibilityForLocation(db, locationId, nowMs))
    } catch (err) {
      logWarn('fleet-health', 'visibility probe failed — not grading blind', {
        err: String(err), locationId,
      })
    }
  }
  return byLocation
}

/** Screenshot retention, in hours. See mig 477 — this is health data. */
const SCREENSHOT_TTL_HOURS = 24

/**
 * Delete captures older than the retention window, objects first.
 *
 * Objects before rows on purpose: if this dies halfway, an orphaned ROW with a
 * dead path is harmless (the signed-url route 404s), whereas an orphaned
 * OBJECT is member health data with nothing left pointing at it, and nothing
 * would ever come back to remove it.
 *
 * Never throws — a prune failure must not fail the tick that alerts on dark
 * devices.
 */
async function pruneScreenshots(db) {
  try {
    const cutoff = new Date(Date.now() - SCREENSHOT_TTL_HOURS * 3600_000).toISOString()
    const { data: stale } = await db
      .from('fleet_commands')
      .select('id, screenshot_path')
      .not('screenshot_path', 'is', null)
      .lt('issued_at', cutoff)
      .limit(500)

    if (!stale?.length) return 0

    const { error: rmError } = await db.storage
      .from('fleet-screenshots')
      .remove(stale.map((c) => c.screenshot_path))
    if (rmError) {
      logWarn('fleet-health', 'failed to delete screenshots', { err: rmError })
      return 0
    }

    await db
      .from('fleet_commands')
      .update({ screenshot_path: null })
      .in('id', stale.map((c) => c.id))

    return stale.length
  } catch (err) {
    logWarn('fleet-health', 'failed to prune screenshots', { err: String(err) })
    return 0
  }
}

/**
 * Mark undelivered commands dead. Returns how many.
 *
 * Never throws: a sweep failure must not fail the tick that alerts on dark
 * devices, which is the more important job of the two.
 */
async function expireStaleCommands(db) {
  try {
    const { data, error } = await db
      .from('fleet_commands')
      .update({ status: 'expired', finished_at: new Date().toISOString() })
      .in('status', ['pending', 'claimed'])
      .lte('expires_at', new Date().toISOString())
      .select('id')
    if (error) {
      logWarn('fleet-health', 'failed to sweep expired commands', { err: error })
      return 0
    }
    return data?.length ?? 0
  } catch (err) {
    logWarn('fleet-health', 'failed to sweep expired commands', { err: String(err) })
    return 0
  }
}

/**
 * How each grade reads at the head of an alert line. The prefix is the first
 * thing an operator sees on a phone, so it carries the severity: DOWN means go
 * and look at the box, ADAPTER means it needs configuring, BLIND means check
 * the room, UNDELIVERED means data is on a clock.
 */
const STATE_LABEL = {
  unreachable: 'DOWN',
  service_down: 'DOWN',
  adapter_down: 'ADAPTER',
  blind: 'BLIND',
  undelivered: 'UNDELIVERED',
}

/**
 * Tell the masters. Push plus email — a push is easy to miss, and this is
 * exactly the kind of thing to find in the morning.
 *
 * The push is sent WITHOUT a category, deliberately. sendPush gates a
 * categorised push on notify_<category>, and resolvePermission's last tier is
 * defaults[role][key] === true — so an UNREGISTERED category resolves FALSE
 * and the push reaches the master who tested it and silently nobody else.
 * This repo has been bitten by that twice (STAFF-DEV.8, PUSH-TEST.1). Fleet
 * health is an operational notice, not a per-person preference, so the master
 * switch and the OS permission stay the only gates.
 *
 * Both channels are best-effort: a failure to notify must never fail the cron,
 * or one Postmark hiccup stops the whole fleet being checked.
 *
 * @returns {Promise<boolean>} whether the alert reached anyone at all. The
 *   caller uses this to decide whether it may record that it has alerted —
 *   claiming an alert nobody received would silence the rest of that outage.
 */
async function notify(db, alerts) {
  const down = alerts.filter((a) => a.alert === 'down')
  const back = alerts.filter((a) => a.alert === 'recovered')

  // BRIDGE-BLIND.1 — say what was found, not "down".
  //
  // A bridge graded `blind`, `adapter_down` or `undelivered` is on the
  // tailnet, heartbeating, and answering everything asked of it. Calling that
  // "down" in a subject line is simply false, and a subject that overstates is
  // how an alert channel loses the benefit of the doubt it needs on the day it
  // is right. The severity lives in the STATE_LABEL prefix on the line itself,
  // which is where it can be specific.
  const hardDown = down.some((a) => a.state === 'unreachable' || a.state === 'service_down')
  const subject = down.length
    ? `Fleet alert: ${down.map((a) => a.name).join(', ')} ${hardDown ? 'down' : 'needs a look'}`
    : `Fleet recovered: ${back.map((a) => a.name).join(', ')}`

  const lines = [
    ...down.map((a) => `${STATE_LABEL[a.state] ?? 'DOWN'} — ${a.name}: ${a.detail}`),
    ...back.map((a) => `RECOVERED — ${a.name}`),
  ]

  const { data: masters } = await db
    .from('profiles')
    .select('id, email')
    .eq('role', 'master')

  let delivered = false

  const ids = (masters || []).map((m) => m.id).filter(Boolean)
  if (ids.length) {
    try {
      const res = await sendPush(ids, {
        title: subject,
        body: lines.join('\n'),
        data: { type: 'fleet_health' },
      })
      // A master with no registered device is not a delivery failure — it just
      // means push isn't a channel for them. Only a push that actually landed
      // counts.
      if ((res?.sent ?? 0) > 0) delivered = true
    } catch (err) {
      logWarn('fleet-health', 'push failed', { err: String(err) })
    }
  }

  const emails = (masters || []).map((m) => m.email).filter(Boolean)
  const html =
    `<p>${lines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br/>')}</p>` +
    `<p><a href="${getAppUrl()}/admin/bridges">Open the bridges admin</a></p>`

  for (const to of emails) {
    try {
      await sendEmail({
        to,
        subject,
        htmlBody: html,
        textBody: lines.join('\n'),
        stream: 'outbound',
        tag: 'fleet-health',
      })
      delivered = true
    } catch (err) {
      logWarn('fleet-health', 'email failed', { err: String(err), to })
    }
  }

  return delivered
}
