import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { buildAuthorizeUrl } from '@/lib/google-business/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  const nonce = randomBytes(24).toString('hex')
  const state = `${nonce}.${locationId}`
  const res = NextResponse.redirect(buildAuthorizeUrl({ state }))
  res.cookies.set('gbp_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  return res
}
