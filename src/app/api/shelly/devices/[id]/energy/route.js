// SHELLY-UI.5 — one device's daily consumption, zero-filled.
//
// PER DEVICE, NEVER PER LOCATION (obligation 9). mig 562's own table comment
// spells out why: 50 devices x 30 days is 1,500 rows, and every PostgREST
// select is capped at 1,000 regardless of `.limit()` — a location-wide read
// would silently lose a third of the estate's history with no error anywhere.
// At most 90 rows come back here, and the `.limit(days)` says so.
//
// ZERO-FILL, AND WHAT A ZERO MEANS. The chart needs a contiguous run of days,
// so a day with no row is emitted as 0 kWh. That is a claim we are not
// entitled to make on its own — "nothing was consumed" and "the cron never
// sampled" look identical at 0 — so `samples` rides alongside it and carries
// the difference: a real quiet day has samples, a gap has none. Task 6's chart
// reads that, not the bar height.
//
// The day strings are the LOCATION's calendar days (dayStrInTz), matching the
// `day` column, which mig 562 defines as the day in locations.timezone at
// sample time. Using a UTC today would put a 23:30 sample under BST — or any
// evening sample in New York — on the wrong bar.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadDevice, requestTz } from '@/lib/shelly/device-load'
import { ShellyEnergyQuery } from '@/lib/shelly/schemas'
import { addDaysISO } from '@/lib/dublin-time'
import { dayStrInTz } from '@/lib/tz-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-energy'

const round3 = (n) => Math.round(n * 1000) / 1000

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

// Wh (numeric(14,3), so it may arrive as a string) → kWh. A value we cannot
// read answers NULL, never 0: absent is not zero (status.js rule 1), and a
// fabricated zero is indistinguishable from a genuinely quiet day. Unreachable
// today — the column is NOT NULL with a >= 0 CHECK — which is exactly why it
// must not be the branch that invents a measurement if that ever changes.
function kwhFrom(wh) {
  const n = typeof wh === 'number' ? wh : typeof wh === 'string' && wh.trim() !== '' ? Number(wh) : NaN
  return Number.isFinite(n) ? round3(n / 1000) : null
}

const intOr0 = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0)

export const GET = withAuth({ permission: 'device_control' }, async ({ user, db, locationId, request, params }) => {
  // The schema absorbs both shapes a query string produces for "not given" —
  // null for an absent param, '' for a bare `?days=` — so this needs no
  // pre-mapping. Junk and out-of-range values still 400.
  const url = new URL(request.url)
  const parsed = ShellyEnergyQuery.safeParse({ days: url.searchParams.get('days') })
  if (!parsed.success) {
    // Same 400 shape validateBody uses, so the client's
    // `issues?.[0]?.message || error` render works here too.
    return NextResponse.json(
      { success: false, error: 'Invalid request', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      { status: 400 },
    )
  }
  const { days } = parsed.data

  const loaded = await loadDevice(db, locationId, params?.id)
  if (!loaded.ok) {
    if (loaded.status === 404) return notFound()
    logError(MODULE, 'device read failed', { locationId, error: loaded.error })
    return bad('Could not load this device', 500)
  }
  const device = loaded.device

  const tz = requestTz(user)
  const to = dayStrInTz(Date.now(), tz)
  // Inclusive of both ends: `days` days ending today.
  const from = addDaysISO(to, -(days - 1))

  const { data, error } = await db
    .from('shelly_energy_daily')
    .select('day, wh_total, samples, resets')
    // The tenant filter is on the QUERY even though device_id already pins one
    // location's row: this table is service-role-read like every other, and a
    // filter that is only implied is a filter that can be refactored away.
    .eq('location_id', locationId)
    // The shelly_devices ROW id (uuid), not the Shelly hex device id — the FK
    // mig 562 defines.
    .eq('device_id', device.id)
    .gte('day', from)
    .lte('day', to)
    .order('day')
    .limit(days)
  if (error) {
    logError(MODULE, 'energy read failed', { locationId, deviceId: device.id, error: error.message })
    return bad('Could not load this device’s energy history', 500)
  }

  const byDay = new Map((data || []).map((r) => [r.day, r]))
  const out = []
  for (let day = from; day <= to; day = addDaysISO(day, 1)) {
    const row = byDay.get(day)
    out.push({
      day,
      // No row => 0 kWh with samples:0, which is how the chart tells a quiet
      // day from a gap. See the header.
      kwh: row ? kwhFrom(row.wh_total) : 0,
      samples: row ? intOr0(row.samples) : 0,
      resets: row ? intOr0(row.resets) : 0,
    })
  }

  return NextResponse.json({ success: true, device_id: device.id, from, to, days: out })
})
