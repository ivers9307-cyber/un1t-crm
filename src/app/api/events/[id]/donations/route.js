// /api/events/[id]/donations
//
// GET — the event's card donations for staff: the rows (newest first), the
//       totals tiles, and the charity settings the page labels the match
//       column with. `?format=csv` returns the hand-over CSV for the charity.
//
// Same gates as /api/events/[id]/teams: races permission at the event's
// location; an event at a studio the caller can't see is a 404.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { DONATION_COLS } from '@/lib/donation-payments'
import { computeCharityTotals, resolveCharitySettings } from '@/lib/charity-donations'
import { getLocationZone, formatInZone, DEFAULT_TZ } from '@/lib/location-time'
import { csvCell } from '@/lib/attendee-csv'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// UTF-8 BOM so Excel renders accented names correctly.
const BOM = '﻿'
const WHEN_FORMAT = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }

async function loadRaceForAccess(db, raceId) {
  return db
    .from('race_events')
    .select('id, name, slug, location_id, charity_enabled, charity, payment_currency')
    .eq('id', raceId)
    .single()
}

const euros = (cents) => ((Number(cents) || 0) / 100).toFixed(2)

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await loadRaceForAccess(db, params.id)
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the event's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, race.location_id, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const settings = resolveCharitySettings(race)
  const currency = race.payment_currency || 'EUR'

  const { data: rows, error } = await db
    .from('donations')
    .select(DONATION_COLS)
    .eq('race_event_id', race.id)
    .eq('location_id', race.location_id)
    .order('paid_at', { ascending: false, nullsFirst: false })
    .range(0, 999)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // Every row, awaiting_payment included however old: with no sweep, an
  // unconfirmed row is exactly what a manager reconciles against the provider
  // dashboard (the page labels it Unconfirmed and offers a re-check).
  const donations = rows || []

  let entries = []
  if (settings.include_entries) {
    const { data, error: entriesErr } = await db
      .from('race_payments')
      .select('amount_cents, status')
      .eq('race_event_id', race.id)
      .eq('status', 'completed')
      .range(0, 999)
    if (entriesErr) return NextResponse.json({ success: false, error: entriesErr.message }, { status: 500 })
    entries = data || []
  }

  const totals = computeCharityTotals({
    donations, entries, multiplier: settings.match_multiplier, includeEntries: settings.include_entries,
  })

  // paid_at is an instant: render it in the event location's zone here so the
  // client (and the CSV) never do zone maths.
  let zone = DEFAULT_TZ
  try {
    zone = await getLocationZone(db, race.location_id)
  } catch (err) {
    logWarn('event-donations', 'location zone read failed; using the default zone', { locationId: race.location_id, error: err?.message })
  }

  const out = donations.map((d) => {
    const paid = d.status === 'paid'
    const mult = Number(d.match_multiplier)
    return {
      id: d.id,
      paid_at: d.paid_at,
      paid_at_label: d.paid_at ? formatInZone(d.paid_at, zone, WHEN_FORMAT) : null,
      donor_name: d.donor_name,
      donor_email: d.donor_email,
      amount_cents: d.amount_cents,
      match_multiplier: d.match_multiplier,
      matched_cents: paid ? Math.round((Number(d.amount_cents) || 0) * (Number.isFinite(mult) && mult >= 1 ? mult : 1)) : 0,
      currency: d.currency,
      status: d.status,
      message: d.message,
      receipt_email_status: d.receipt_email_status,
      refunded_at: d.refunded_at,
    }
  })

  const url = new URL(request.url)
  if (url.searchParams.get('format') === 'csv') {
    const header = ['paid_at', 'name', 'email', 'amount', 'matched', 'status', 'message']
    const lines = [header.join(',')]
    for (const d of out) {
      lines.push([
        d.paid_at_label || '', d.donor_name || '', d.donor_email || '',
        euros(d.amount_cents), euros(d.matched_cents), d.status, d.message || '',
      ].map(csvCell).join(','))
    }
    const safe = String(race.slug || race.name || 'event')
      .replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event'
    return new Response(BOM + lines.join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safe}-donations.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      donations: out,
      totals,
      currency,
      settings: { name: settings.name, match_multiplier: settings.match_multiplier, include_entries: !!settings.include_entries },
    },
  })
}
