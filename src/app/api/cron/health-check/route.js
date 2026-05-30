// GET /api/cron/health-check
//
// Liveness probe for external uptime monitoring (BetterStack, etc.).
// Returns 200 when the app can reach its database, 503 otherwise — so a
// real DB outage trips the monitor even when the Next.js server is up.
//
// Public (listed in proxy.js publicPaths under /api/cron/) so the
// monitor doesn't need auth. No secrets exposed — just a count.
// Deliberately does NOT require CRON_SECRET — read-only liveness check.
//
// RESILIENCE (2026-05-30): the original returned 503 on the FIRST DB
// hiccup, so a single transient blip (Supabase pooler reconnect, a cold
// serverless connection, a momentary network glitch — all of which
// self-heal in well under a second) tripped BetterStack and paged the
// whole team. That produced repeated false "service down" alerts while
// the app was actually fine. A liveness probe feeding a pager must only
// fail on a SUSTAINED problem, so we now: bound each attempt with a
// timeout, and retry once after a short backoff before declaring 503.
// A genuine outage still fails both attempts and trips the alert.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ATTEMPT_TIMEOUT_MS = 2500
const RETRY_DELAY_MS = 400

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One DB round-trip, bounded by a timeout. Resolves { ok, error }.
async function probe() {
  const db = createServerClient()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  try {
    // Cheapest possible round-trip: HEAD-style count on a tiny table.
    const { error } = await db
      .from('locations')
      .select('id', { count: 'exact', head: true })
      .abortSignal(controller.signal)
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'health check failed' }
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  // First attempt.
  let result = await probe()
  if (result.ok) return NextResponse.json({ ok: true })

  // Transient blip? Back off briefly and try once more. Only a
  // sustained failure (both attempts) returns 503 and trips the alert.
  await sleep(RETRY_DELAY_MS)
  result = await probe()
  if (result.ok) return NextResponse.json({ ok: true, recovered: true })

  return NextResponse.json({ ok: false, error: result.error }, { status: 503 })
}
