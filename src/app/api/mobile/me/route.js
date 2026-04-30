// Mobile bootstrap endpoint.
//
// Called by the iOS app immediately after login to retrieve everything it
// needs in a single round-trip:
//   - Profile (id, name, role)
//   - Assigned locations + active location
//   - permissions.mobile.* (which tabs to show)
//   - permissions.* (web flags, in case the app ever surfaces them)
//
// Auth: Supabase JWT in Authorization header (handled by middleware +
// getCurrentUser()'s Bearer fallback).
//
// We deliberately don't return PII for other staff or any HR fields here
// — this is a minimal "what can I do, where am I" payload.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Strip server-only fields. The mobile app should never see these.
  const safeProfile = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    avatar_url: user.avatar_url || null,
    permissions: user.permissions || {},
  }

  return NextResponse.json({
    success: true,
    data: {
      profile: safeProfile,
      locations: (user.locations || []).map(l => ({
        id: l.id,
        name: l.name,
        slug: l.slug,
        country: l.country || null,
      })),
      activeLocation: user.activeLocation
        ? {
            id: user.activeLocation.id,
            name: user.activeLocation.name,
            slug: user.activeLocation.slug,
            country: user.activeLocation.country || null,
          }
        : null,
    },
  })
}
