// FEES.3 — POST a member's appeal against a class fee. Public: the token in
// the body is the credential (only its sha256 is stored). Body
// { token, reason: illness|injury|emergency|other, text? }. An appeal holds
// the fee until staff decide. Rate-limited per IP and per token; every
// refusal answers the same 404 shape, so a token cannot be probed.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'
import { submitAppeal, hashAppealToken, APPEAL_REASONS } from '@/lib/class-fees-member'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const FeeAppealSchema = z.object({
  token: z.string().min(32).max(64).regex(/^[A-Za-z0-9_-]+$/),
  reason: z.enum(APPEAL_REASONS),
  text: z.string().max(1000).optional(),
})

const CLOSED = 'This link has expired or the fee has already been dealt with. Contact the studio if you need help.'

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request) || 'unknown'
  const byIp = await checkRateLimit(db, `fee-appeal-ip:${ip}`, { max: 10, windowMs: 10 * 60_000 })
  if (!byIp.allowed) return NextResponse.json({ success: false, error: 'Too many attempts. Try again later.' }, { status: 429 })
  const validation = await validateBody(request, FeeAppealSchema)
  if (!validation.ok) return validation.response
  const { token, reason, text } = validation.data
  const byToken = await checkRateLimit(db, `fee-appeal-token:${hashAppealToken(token).slice(0, 16)}`, { max: 5, windowMs: 10 * 60_000 })
  if (!byToken.allowed) return NextResponse.json({ success: false, error: 'Too many attempts. Try again later.' }, { status: 429 })
  try {
    const r = await submitAppeal(db, { token, reason, text })
    if (!r.ok) return NextResponse.json({ success: false, error: CLOSED }, { status: 404 })
    return NextResponse.json({ success: true, data: { appealed: true } })
  } catch (err) {
    logError('class-fees', 'appeal submit failed', { code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Something went wrong. Please try again in a minute.' }, { status: 500 })
  }
}
