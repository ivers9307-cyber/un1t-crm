// GET /api/cars/[id]/xero-contact-search?q=<query>
//
// Live search against Xero Contacts for the car's location's Xero
// org. Used by the buyer-details combobox on the car detail page —
// type 3+ chars, get a debounced list of matching contacts, click
// to auto-populate buyer fields.
//
// We don't cache locally — this is a low-frequency UX affordance
// (1 lookup per car deal) and Xero's rate limits are generous
// enough. If/when this becomes a hot path we'd subscribe to
// CONTACT events on the existing webhook + back the search with
// a local table; that's deliberately out of scope here.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { withFreshToken, XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function escapeXeroWhere(s) {
  return String(s).replace(/"/g, '""');
}

export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') || '').trim()
  if (q.length < 2) {
    return NextResponse.json({ success: true, contacts: [] })
  }

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  try {
    const { xfetch } = await withFreshToken(car.location_id)
    // Xero's WHERE supports Name.Contains() and EmailAddress.Contains().
    // Using OR catches partial matches on either field — the most
    // common typing pattern (operator types either the buyer's name
    // or their email).
    const safe = escapeXeroWhere(q)
    const where = encodeURIComponent(
      `Name!=null && (Name.ToLower().Contains("${safe.toLowerCase()}") || (EmailAddress!=null && EmailAddress.ToLower().Contains("${safe.toLowerCase()}")))`,
    )
    // page=1 caps at 100; we slim further client-side. order alphabetically.
    const json = await xfetch(`/Contacts?where=${where}&order=Name ASC&page=1`)
    const contacts = (json?.Contacts || []).slice(0, 25).map(c => ({
      id: c.ContactID,
      name: c.Name,
      email: c.EmailAddress || null,
      phone: c.Phones?.find(p => p.PhoneNumber)?.PhoneNumber || null,
      address: (() => {
        const a = c.Addresses?.find(x => x.AddressLine1)
        if (!a) return null
        return [a.AddressLine1, a.AddressLine2, a.City, a.PostalCode, a.Country]
          .filter(Boolean).join(', ')
      })(),
    }))
    return NextResponse.json({ success: true, contacts })
  } catch (e) {
    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({ success: false, error: e.message || 'Xero lookup failed' }, { status })
  }
}
