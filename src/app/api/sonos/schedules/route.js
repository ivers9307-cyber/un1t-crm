// SONOS.14 — schedule list + create.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const MINUTES_PER_DAY = 24 * 60

function toMinutes(hhmm) {
  const s = String(hhmm || '')
  // HHMM has only one capture group (around the hour — its sole original
  // purpose was a boolean .regex() check), so pulling minutes out of a
  // capture-group index is fragile. Validate with .test(), then split.
  if (!HHMM.test(s)) return null
  const [hh, mm] = s.split(':')
  return Number(hh) * 60 + Number(mm)
}

// A same-day window (off after on) occupies one clock range. An overnight
// window (off before on — the Window .refine below already refuses
// on === off, so "not after" only ever means "before") is modelled as
// wrapping the clock face: the late segment up to midnight AND the early
// segment from midnight. That is deliberately what the window occupies on
// every day it recurs on — the tail of yesterday's run lands in exactly
// that early-morning slot (resolveServeWindows in
// src/lib/schedule/desired-state.js serves it) — so a single, non-recurring
// overnight window gets the same treatment as a recurring one. The cost is
// a rare false positive on a genuinely isolated overnight window with no
// neighbour; the alternative is a miss on the case this exists to catch.
function occupiedSegments(on, off) {
  const onMin = toMinutes(on)
  const offMin = toMinutes(off)
  if (onMin == null || offMin == null) return []
  if (offMin > onMin) return [[onMin, offMin]]
  return [[onMin, MINUTES_PER_DAY], [0, offMin]]
}

// Half-open — touching boundaries (one window's off equals the other's on)
// is fine, matching planAction's own `nowMs < off_at` check.
function segmentsOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1]
}

function sharesDay(daysA, daysB) {
  const a = Array.isArray(daysA) ? daysA : []
  const b = Array.isArray(daysB) ? daysB : []
  return a.some((d) => b.includes(d))
}

// Pure — no zod, no I/O — so it is unit-tested directly (route.test.js)
// and reused by the SchedulePayload refinement below.
//
// Why this exists: planAction resolves an overlap earliest-wins (windows
// is sorted ascending by on_at, then .find() returns the first match), so
// a later-starting or nested window in a clashing pair is silently NEVER
// applied — no error, no log line, no way for an operator to tell why a
// window does nothing. Refusing the save at write time is the only place
// this can surface.
//
// Returns the first clashing [windowA, windowB] pair found, or null.
export function findWindowOverlap(windows) {
  const list = Array.isArray(windows) ? windows : []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (!sharesDay(a?.days, b?.days)) continue
      const segsA = occupiedSegments(a?.on, a?.off)
      const segsB = occupiedSegments(b?.on, b?.off)
      if (segsA.some((sa) => segsB.some((sb) => segmentsOverlap(sa, sb)))) {
        return [a, b]
      }
    }
  }
  return null
}

export const Window = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  on: z.string().regex(HHMM),
  off: z.string().regex(HHMM),
  volume: z.number().int().min(0).max(100),
  favorite_id: z.string().min(1).max(128),
}).refine((w) => w.on !== w.off, {
  // Equal boundaries make the engine treat the window as overnight and
  // resolve a 24-hour always-on span — the exact trap the Tapo build hit.
  message: 'A window must not start and end at the same time',
})

export const SchedulePayload = z.object({
  name: z.string().min(1).max(80).optional(),
  player_ids: z.array(z.string().min(1)).max(32).optional(),
  enabled: z.boolean().optional(),
  windows: z.array(Window).max(16).superRefine((windows, ctx) => {
    // Cross-item check: a single Window's own .refine only catches
    // on === off. Two DIFFERENT windows that overlap on a shared day pass
    // that check individually and are only wrong together — see
    // findWindowOverlap above for why an undetected overlap is a silent,
    // permanent dead window rather than a loud failure.
    const clash = findWindowOverlap(windows)
    if (!clash) return
    const [a, b] = clash
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Windows overlap on the same day: ${a.on}-${a.off} and ${b.on}-${b.off}`,
    })
  }).optional(),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, schedules: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const parsed = SchedulePayload.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .insert({ location_id: locationId, ...parsed.data })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, schedule: data })
}
