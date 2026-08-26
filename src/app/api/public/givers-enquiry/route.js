// POST /api/public/givers-enquiry — contact-form capture for the
// giversautos.com coming-soon page (GIVERS-WEB.1; was ccf-enquiry).
//
// Anonymous by design (/api/public/** is route-guards-exempt); the
// abuse guard is the rate limit — deliberately NO honeypot, because
// browser autofill of hidden fields silently dropped real signups on
// /api/public/leads. Writes land in car_enquiries (mig 479), read
// later by the CRM cars section via service-role routes.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { giversEnquirySchema } from '@/lib/schemas'

export const runtime = 'nodejs'

export async function POST(request) {
  const validation = await validateBody(request, giversEnquirySchema)
  if (!validation.ok) return validation.response
  const { name, phone, email, message } = validation.data

  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `givers-enquiry:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many enquiries from this connection. Please call us on 086 822 5779 instead.')
  }

  const { error } = await db.from('car_enquiries').insert({
    name,
    phone,
    email: email || null,
    message: message || null,
  })
  if (error) {
    return NextResponse.json(
      { success: false, error: 'Could not send your enquiry. Please call us on 086 822 5779.' },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
