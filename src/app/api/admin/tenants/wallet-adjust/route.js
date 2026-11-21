// POST /api/admin/tenants/wallet-adjust — the ONE write action on the
// /admin/tenants console (INTEG-D2): a master posts a signed goodwill
// credit/debit to a location's wallet.
//
// Goes through applyWalletEntry → the wallet_apply RPC (the ONLY
// wallet write path — service-role-only, row-locked, append-only
// ledger; mig 420) with kind='adjustment'. Audited twice over: the
// ledger row carries created_by = the acting master, and the action
// lands in the admin audit log. Bounds: non-zero, within ±EUR 10,000;
// note (min 5 chars) is REQUIRED — an unexplained adjustment is not a
// thing. Every location today is unpinned, so adjustments are
// financially inert until enforcement lands — built properly anyway.
//
// Skeleton: getCurrentUser → master check → validateBody →
// existence check (404) → RPC → { success, data }.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody, uuidLike } from '@/lib/validate'
import { applyWalletEntry } from '@/lib/wallet'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ±EUR 10,000 — a goodwill lever, not a treasury. Larger movements
// should be deliberate enough to need two entries (and a conversation).
export const MAX_ADJUST_CENTS = 1_000_000

const AdjustBody = z.object({
  locationId: uuidLike,
  amountCents: z.number().int()
    .refine((n) => n !== 0, 'Amount must be non-zero (signed cents: positive = credit, negative = debit)')
    .refine((n) => Math.abs(n) <= MAX_ADJUST_CENTS, `Amount must be within ±${MAX_ADJUST_CENTS} cents (±€10,000)`),
  note: z.string().trim().min(5, 'A note of at least 5 characters is required').max(500),
})

// withAuth only signs the caller in. Every check after it runs by hand, in the
// order it always has (profiles.role master 403, body 400, location 404), and
// the wallet write is unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, AdjustBody)
  if (!validation.ok) return validation.response
  const { locationId, amountCents, note } = validation.data


  // Existence check first — a clean 404 beats an FK error from the RPC
  // (and 404 not 403: detail semantics, ids aren't enumerable).
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) {
    logError('wallet-adjust', 'location read failed', { locationId, err: locErr })
    return NextResponse.json({ success: false, error: 'Could not read the location.' }, { status: 500 })
  }
  if (!location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  let balanceCents
  try {
    balanceCents = await applyWalletEntry(db, {
      locationId,
      kind: 'adjustment',
      amountCents,
      note,
      createdBy: user.id,
    })
  } catch (e) {
    // wallet_apply enforces the -1000c grace floor and kind semantics. Its
    // text is database text (it names the location id and the balance), so it
    // is logged and the caller gets a fixed line, still a 400.
    logError('wallet-adjust', 'wallet_apply refused the adjustment', { locationId, err: e?.message || String(e) })
    const floor = /grace floor/.test(String(e?.message || ''))
    return NextResponse.json({
      success: false,
      error: floor ? 'That debit would take the wallet below its grace floor.' : 'The adjustment could not be applied.',
    }, { status: 400 })
  }

  // Fire-and-forget secondary audit trail — never blocks the response
  // (the ledger row above is the primary record).
  try {
    await logAuditEvent({
      category: 'admin',
      action: 'wallet_adjustment',
      actor: user,
      target: { resource: `locations/${location.id}`, label: location.name },
      locationId,
      details: { amount_cents: amountCents, note, balance_after_cents: balanceCents },
      request,
    })
  } catch {
    // logAuditEvent already swallows its own errors; belt and braces.
  }

  return NextResponse.json({ success: true, data: { locationId, balanceCents } })
})
