// POST /api/locations/[id]/ac-devices/discover — list a vendor's AC units so a
// master can pick which to add at the location in the PATH.
//
//   Body { provider: 'sensibo', api_key? }
//     or { provider: 'thinq', pat?, client_id?, country_code? }
//
// A credential in the body is one the operator has just typed (to try it
// before saving). Anything missing comes from the credentials stored on [id],
// never on the caller's active studio.
//
// ACDEVLOC.1 — replaces GET /api/studio-management/ac/pods?api_key=… and
// GET …/lg-devices?pat=…. A credential in a query string is written to
// Vercel's request log, any drain or proxy log and the browser's network log;
// the settings tab prefilled the stored key, so every Add Sensibo click put
// the live key in a URL. Here: POST body only; the answer carries unit ids and
// names only (no vendor `raw`); a vendor error message is scrubbed of the
// credential before it is returned; logError gets status and code only.
// (Sensibo's own API takes the key as ?apiKey= — that is its contract, on a
// server-to-vendor call no log of ours records.)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { listPods, SensiboError } from '@/lib/sensibo'
import { listDevices, ThinqError } from '@/lib/thinq'
import { readAcCredentials, redactSecrets, publicPod, publicThinqDevice } from '@/lib/ac-device-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DiscoverBody = z.object({
  provider: z.enum(['sensibo', 'thinq']),
  api_key: z.string().max(4000).optional(),
  pat: z.string().max(4000).optional(),
  client_id: z.string().max(200).optional(),
  country_code: z.string().max(8).optional(),
})

function vendorFailure(e, ErrorClass, code, secrets, locationId) {
  const known = e instanceof ErrorClass
  const status = known && e.status === 401 ? 401 : 502
  const message = redactSecrets(known ? e.message : (e?.message || 'The vendor did not answer.'), secrets)
  logError('ac-devices', 'discovery failed', { locationId, code, status: known ? (e.status ?? null) : null })
  return NextResponse.json({ success: false, error: message, code }, { status })
}

export async function POST(request, props) {
  const params = await props.params
  const locationId = params?.id || null
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!locationId) return NextResponse.json({ success: false, error: 'Location id required.' }, { status: 400 })
  const notMember = assertLocationAccessOr404(user, locationId)
  if (notMember) return notMember
  if (!user.isMaster) {
    return NextResponse.json({ success: false, error: 'Only master can discover AC devices.' }, { status: 403 })
  }

  const parsed = await validateBody(request, DiscoverBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const db = createServerClient()
  const read = await readAcCredentials(db, locationId)
  if (read.error) {
    logError('ac-devices', 'credentials read failed', { locationId, err: read.error.message })
    return NextResponse.json({ success: false, error: "Could not read this location's AC credentials. Try again." }, { status: 500 })
  }
  if (read.notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const stored = read.creds

  if (body.provider === 'sensibo') {
    const apiKey = body.api_key?.trim() || stored.sensiboApiKey
    if (!apiKey) {
      return NextResponse.json({
        success: false,
        error: 'No Sensibo API key typed or saved on this location.',
        code: 'sensibo_not_configured',
      }, { status: 400 })
    }
    try {
      const pods = await listPods(apiKey)
      return NextResponse.json({ success: true, data: pods.map(publicPod) })
    } catch (e) {
      return vendorFailure(e, SensiboError, 'sensibo_error', [apiKey], locationId)
    }
  }

  const pat = body.pat?.trim() || stored.thinqPat
  const clientId = body.client_id?.trim() || stored.thinqClientId
  const countryCode = body.country_code?.trim() || stored.thinqCountryCode || 'IE'
  if (!pat) {
    return NextResponse.json({
      success: false,
      error: 'No LG ThinQ PAT typed or saved on this location.',
      code: 'thinq_not_configured',
    }, { status: 400 })
  }
  if (!clientId) {
    return NextResponse.json({
      success: false,
      error: 'No ThinQ client id on this location yet. Save the PAT first; a client id is generated then.',
      code: 'thinq_not_configured',
    }, { status: 400 })
  }
  try {
    const devices = await listDevices({ pat, clientId, countryCode })
    return NextResponse.json({ success: true, data: devices.map(publicThinqDevice) })
  } catch (e) {
    return vendorFailure(e, ThinqError, 'thinq_error', [pat, clientId], locationId)
  }
}
