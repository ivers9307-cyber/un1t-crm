// POST /api/staff-devices/nudge — push "your app is out of date" to the
// staff who genuinely are (STAFF-DEV.8).
//
// SECURITY: two properties carry this route.
//   1. Service-role reads mean NO RLS. hasPermission(user,'settings') is
//      the only thing between an ordinary staffer and the ability to
//      push a notification to the whole fleet.
//   2. The client sends profile IDS ONLY. Who is outdated is recomputed
//      here from device_tokens and intersected with the request, so a
//      caller can never nudge someone who is perfectly up to date by
//      claiming they are behind. The UI's list is a convenience, never
//      an authority.
//
// Throttle: one nudge per device per 24h, held on
// device_tokens.last_update_nudge_at (mig 466) of the CURRENT device —
// the same row every other verdict keys off. Server-side because a
// client-side guard is a suggestion, and because the operator may have
// several tabs open.
//
// Nothing here 500s on a push failure: Expo being down is not the
// operator's problem to debug, it just means nothing was sent, and the
// throttle is deliberately NOT stamped in that case so a retry is
// possible immediately.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { sendPush } from '@/lib/push'
import { deriveTargetVersion, deviceVerdict, currentDevice } from '@/lib/staff-devices'

export const runtime = 'nodejs'

/** One nudge per device per day — a second click inside the window is a no-op. */
const THROTTLE_MS = 24 * 60 * 60 * 1000

/** PostgREST caps every select at 1,000 rows; both reads here are staff-sized. */
const PAGE_MAX = 1000

const DEFAULT_BODY =
  'Please update Repset from the App Store — your version is out of date.'

const NudgeSchema = z.object({
  profile_ids: z.array(uuidLike).min(1).max(200),
  // Operator-editable copy (house rule: customer/staff-facing wording is
  // never hard-coded without an override). Capped so it can't be used to
  // stuff an essay through the push pipeline.
  message: z.string().trim().min(1).max(200).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'settings')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, NudgeSchema)
  if (!validation.ok) return validation.response
  const { profile_ids: requestedIds, message } = validation.data

  const db = createServerClient()

  // supabase-js builders are thenables — try/await/catch, never .catch().
  let profiles = []
  let devices = []
  try {
    const [profilesRes, devicesRes] = await Promise.all([
      db.from('profiles').select('id, active').eq('active', true).range(0, PAGE_MAX - 1),
      db
        .from('device_tokens')
        .select('id, user_id, app_version, last_seen_at, last_update_nudge_at')
        .order('last_seen_at', { ascending: false })
        .order('id', { ascending: true })
        .range(0, PAGE_MAX - 1),
    ])
    if (profilesRes.error) throw new Error(profilesRes.error.message)
    if (devicesRes.error) throw new Error(devicesRes.error.message)
    profiles = profilesRes.data || []
    devices = devicesRes.data || []
  } catch (err) {
    console.error('[staff-devices/nudge] fleet load failed', err)
    return NextResponse.json({ success: false, error: 'Failed to load staff devices' }, { status: 500 })
  }

  // One clock for the whole request, so the verdicts and the throttle
  // window agree with each other.
  const now = Date.now()

  const byUser = new Map()
  for (const device of devices) {
    if (!device?.user_id) continue
    const list = byUser.get(device.user_id)
    if (list) list.push(device)
    else byUser.set(device.user_id, [device])
  }

  // Same target as GET /api/staff-devices: derived from ACTIVE staff's
  // non-stale devices, so a leaver's newer phone can't make the whole
  // fleet "outdated" and nudge-able.
  const activeIds = new Set(profiles.map((p) => p.id))
  const targetVersion = deriveTargetVersion(
    devices.filter((d) => activeIds.has(d.user_id)),
    now,
  )

  const recipientIds = []
  const deviceIdsToStamp = []
  let skippedThrottled = 0
  let skippedNoToken = 0

  // Deduplicate: a repeated id in the request must not double-push.
  for (const id of new Set(requestedIds)) {
    // An id we don't recognise as active staff is simply ignored — never
    // trusted into a send.
    if (!activeIds.has(id)) continue

    const own = byUser.get(id) || []
    const verdict = deviceVerdict(own, targetVersion, now)
    if (verdict.kind === 'no_device') {
      // No token by definition — a push has nowhere to land.
      skippedNoToken++
      continue
    }
    // 'current' and 'unknown_version' are not nudge-able: we only ever
    // tell someone to update when we can see they are behind.
    if (verdict.kind !== 'outdated') continue

    const device = currentDevice(own)
    const lastNudge = device?.last_update_nudge_at ? Date.parse(device.last_update_nudge_at) : NaN
    if (Number.isFinite(lastNudge) && now - lastNudge < THROTTLE_MS) {
      skippedThrottled++
      continue
    }

    recipientIds.push(id)
    if (device?.id) deviceIdsToStamp.push(device.id)
  }

  if (recipientIds.length === 0) {
    return NextResponse.json({
      success: true,
      data: { sent: 0, skipped_throttled: skippedThrottled, skipped_no_token: skippedNoToken },
    })
  }

  // One batched send (sendPush fans out per token internally). Its
  // counters are aggregated across tokens, so they can't be attributed
  // back to individuals — `sent` below is the number of STAFF the nudge
  // went out for, reported only once at least one ticket came back ok.
  //
  // NO `category` ON PURPOSE. sendPush gates a categorised push on
  // `notify_<category>`, and resolvePermission's last tier is
  // `defaults[role][key] === true` — so an UNREGISTERED key resolves to
  // FALSE for every staffer holding a location assignment, not "no
  // opinion". Passing `category: 'app_update'` would therefore skip
  // essentially the whole fleet and the nudge would silently reach
  // nobody. Categoryless keeps the master `push_notifications` switch
  // (and the device permission) as the only gates, which is right for an
  // operational "your build is stale" notice: it is not a preference.
  // Android routing comes from `data.type` instead — TYPE_CHANNELS maps
  // 'app_update' to the existing Updates channel.
  let pushed = 0
  try {
    const result = await sendPush(recipientIds, {
      title: 'App update available',
      body: message || DEFAULT_BODY,
      data: { type: 'app_update' },
    })
    pushed = result?.sent ?? 0
  } catch (err) {
    // A push failure is reported in the counts, never as a 500.
    console.error('[staff-devices/nudge] push failed', err)
  }

  if (pushed === 0) {
    return NextResponse.json({
      success: true,
      data: { sent: 0, skipped_throttled: skippedThrottled, skipped_no_token: skippedNoToken },
    })
  }

  // Stamp the throttle only for a send that actually landed — an Expo
  // outage must not lock the operator out for the next 24 hours.
  if (deviceIdsToStamp.length) {
    try {
      const { error } = await db
        .from('device_tokens')
        .update({ last_update_nudge_at: new Date(now).toISOString() })
        .in('id', deviceIdsToStamp)
      if (error) throw new Error(error.message)
    } catch (err) {
      // The push already went out; failing the response now would invite
      // a retry that double-pushes. Loud in the logs, quiet to the caller.
      console.error('[staff-devices/nudge] throttle stamp failed', err)
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      sent: recipientIds.length,
      skipped_throttled: skippedThrottled,
      skipped_no_token: skippedNoToken,
    },
  })
}
