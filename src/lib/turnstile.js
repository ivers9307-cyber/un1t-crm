// TURNSTILE.1 — Cloudflare Turnstile bot check for the public forms that
// create contacts (leads, trial and open-week bookings, corp claims, event
// sign-ups, host lists, the givers enquiry).
//
// The browser widget (src/components/useTurnstile.jsx) gets a one-use token
// and sends it in the `cf-turnstile-response` HEADER, so no route schema
// changes. The route calls `refuseUnlessHuman()` before it writes anything.
//
// Configuration (Vercel env), all three explicit:
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY  the widget's site key (public)
//   TURNSTILE_SECRET_KEY            the widget's secret, for siteverify
//   TURNSTILE_MODE                  'monitor' or 'enforce'
//
// No secret = the check is OFF and the widget renders nothing. That is the
// state until the owner creates the widget in Cloudflare; it is deliberate,
// not a fallback, and `turnstileConfig()` reports it for the health view.
//
// 'monitor' verifies every token and logs what it would have refused, but
// lets everything through. Run it for a week or two, read the logs, then set
// 'enforce'. A TURNSTILE_MODE that is neither value is treated as monitor and
// logged as an error: refusing real people on a typo is the worse failure.
//
// FAIL OPEN on Cloudflare itself. If siteverify is unreachable, slow or
// answers garbage, the request goes through and is logged. Never trade a rare
// bot for a certain lost customer (CLAUDE.md, supabase-traps): a sign-up
// turned away by our own outage is gone, a bot row can be cleaned up.

import { NextResponse } from 'next/server'
import { logWarn, logError } from '@/lib/log'

export const TURNSTILE_HEADER = 'cf-turnstile-response'
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const VERIFY_TIMEOUT_MS = 4000

export function turnstileConfig(env = process.env) {
  const secret = env.TURNSTILE_SECRET_KEY || ''
  if (!secret) return { enabled: false, mode: 'off', secret: '' }
  const raw = (env.TURNSTILE_MODE || '').trim()
  const mode = raw === 'enforce' ? 'enforce' : 'monitor'
  return { enabled: true, mode, secret, modeIsValid: raw === 'enforce' || raw === 'monitor' }
}

/**
 * Ask Cloudflare whether the token is good.
 * @returns {Promise<{ verdict: 'pass'|'fail'|'unavailable', codes?: string[] }>}
 */
export async function verifyTurnstileToken(token, { secret, ip = null, fetchImpl = fetch } = {}) {
  if (!token) return { verdict: 'fail', codes: ['missing-input-response'] }
  try {
    const form = new URLSearchParams({ secret, response: token })
    if (ip) form.set('remoteip', ip)
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!res.ok) return { verdict: 'unavailable', codes: [`http-${res.status}`] }
    const data = await res.json()
    if (data?.success === true) return { verdict: 'pass' }
    const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : []
    // A bad SECRET is our misconfiguration, not a bot: never refuse on it.
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      return { verdict: 'unavailable', codes }
    }
    return { verdict: 'fail', codes }
  } catch (err) {
    return { verdict: 'unavailable', codes: [err?.name || 'error'] }
  }
}

/**
 * Gate a public form. Returns a 400 NextResponse to send back when the
 * request must be refused, or null to carry on.
 *
 * @param {Request} request
 * @param {string} form  short name for the logs, e.g. 'leads'
 */
export async function refuseUnlessHuman(request, form, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = turnstileConfig(env)
  if (!cfg.enabled) return null
  if (!cfg.modeIsValid) {
    logError('turnstile', 'TURNSTILE_MODE is not "monitor" or "enforce"; running as monitor', { form })
  }

  const token = request.headers.get(TURNSTILE_HEADER) || ''
  const ip = request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || null
  const result = await verifyTurnstileToken(token, { secret: cfg.secret, ip, fetchImpl })

  if (result.verdict === 'pass') return null
  if (result.verdict === 'unavailable') {
    logWarn('turnstile', 'siteverify unavailable; let through', { form, codes: result.codes })
    return null
  }
  if (cfg.mode === 'monitor') {
    logWarn('turnstile', 'would refuse (monitor mode)', { form, codes: result.codes, hadToken: Boolean(token) })
    return null
  }
  logWarn('turnstile', 'refused', { form, codes: result.codes, hadToken: Boolean(token) })
  return NextResponse.json(
    { success: false, error: "We couldn't confirm you're not a bot. Please try again." },
    { status: 400 },
  )
}
