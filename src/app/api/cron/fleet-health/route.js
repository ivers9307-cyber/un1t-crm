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
} from '@/lib/fleet-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Dormant until configured — same pattern as the Homey integration. The
  // heartbeat still stamps, so cron_health does not report this as stale
  // merely for being unconfigured.
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
  const { data: bridgeRows } = await db
    .from('ble_bridges')
    .select('id, name, hardware_id, tailscale_hostname, status, last_seen_at')
  const bridgeByName = indexBridgesByDevice(bridgeRows)

  const names = fleet.map(deviceNameOf).filter(Boolean)
  const { data: priorRows } = await db
    .from('fleet_device_health')
    .select('device_name, state, state_since, alerted_at')
    .in('device_name', names)
  const priorByName = new Map((priorRows || []).map((r) => [r.device_name, r]))

  const alerts = []
  const rows = []

  for (const device of fleet) {
    const name = deviceNameOf(device)
    if (!name) continue
    const graded = gradeDevice(device, bridgeByName.get(name) ?? null, now)
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

  await stampHeartbeat('fleet-health', {
    configured: true,
    checked: rows.length,
    alerted: alerts.length,
  })

  return NextResponse.json({
    success: true,
    data: { checked: rows.length, alerted: alerts.length },
  })
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

  const subject = down.length
    ? `Fleet alert: ${down.map((a) => a.name).join(', ')} down`
    : `Fleet recovered: ${back.map((a) => a.name).join(', ')}`

  const lines = [
    ...down.map((a) => `DOWN — ${a.name}: ${a.detail}`),
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
