import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { withFreshToken, listLocations } from '@/lib/google-business/client'
import { fullLocationResource } from '@/lib/google-business/reviews'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  try {
    const { conn, accessToken } = await withFreshToken(locationId)
    const locs = await listLocations(accessToken, conn.account_resource)
    const data = locs.map((l) => ({ resource: fullLocationResource(conn.account_resource, l.name), title: l.title || l.name }))
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
