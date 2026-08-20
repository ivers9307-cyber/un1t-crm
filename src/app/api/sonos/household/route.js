// SONOS.13 — live players + favourites for the config UI.
// Service-role route: authorise in app code, scope by active location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosGetFavorites } from '@/lib/sonos/client'
import { mapGroups } from '@/lib/sonos/groups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return NextResponse.json({ success: true, connected: false, reason: 'not_configured' })

  const db = createServerClient()
  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) return NextResponse.json({ success: true, connected: false, reason: tok.reason })

  const [groupsRes, favRes] = await Promise.all([
    sonosGetGroups(tok.token, tok.householdId),
    sonosGetFavorites(tok.token, tok.householdId),
  ])
  if (!groupsRes.ok) {
    return NextResponse.json({ success: true, connected: true, reachable: false, statusCode: groupsRes.statusCode })
  }

  const { groups, players } = mapGroups(groupsRes.body)
  // A failed favourites fetch is a DIFFERENT fact from the household
  // genuinely having none saved — groupsRes.ok already proved the household
  // itself answered, so folding a favourites-only failure into `favorites:
  // []` would tell the UI (and the operator) "nothing saved", which also
  // silently blocks adding a window. Surface it as its own signal instead —
  // an error the UI can offer a retry for, not a false statement about the
  // Sonos account.
  const favoritesFailed = !favRes.ok
  // getFavorites returns the array under `items`, NOT `favorites` — verified
  // against the reference docs. Capped at 70 by Sonos.
  const favorites = favoritesFailed ? [] : (favRes.body?.items || []).map((f) => ({ id: f.id, name: f.name || '' }))

  return NextResponse.json({
    success: true,
    connected: true,
    reachable: true,
    groups,
    players,
    favorites,
    ...(favoritesFailed ? { favoritesFailed: true, favoritesStatusCode: favRes.statusCode } : {}),
  })
}
