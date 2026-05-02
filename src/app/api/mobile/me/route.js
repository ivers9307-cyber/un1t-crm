// Mobile bootstrap endpoint.
//
// Called by the iOS app immediately after login to retrieve everything it
// needs in a single round-trip:
//   - Profile (id, name, role)
//   - Assigned locations + active location, each with its per-location
//     permissions blob (mig 058)
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
  // `role` here is the active-location role (mig 051) — switching
  // active location via the x-active-location header on the next
  // request flips it.
  //
  // `permissions` is no longer returned at the profile level (mig
  // 058). The user-override layer is per-location now and lives on
  // each location's assignment row, returned alongside the location
  // below.
  const safeProfile = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    isMaster: !!user.isMaster,
    avatar_url: user.avatar_url || null,
    // Per-location roles (mig 051). The mobile app reads this when
    // the user switches active location locally, so role-default
    // resolution can flip without a /me refetch.
    rolesByLocation: user.rolesByLocation || {},
  }

  // Per-location permissions (mig 058) — merge each location with
  // its assignment's permissions blob so the mobile app's canMobile
  // / canDashboard helpers can resolve per-location overrides
  // without an additional round-trip.
  const assignmentsByLocation = user.assignmentsByLocation || {}

  return NextResponse.json({
    success: true,
    data: {
      profile: safeProfile,
      locations: (user.locations || []).map(l => ({
        id: l.id,
        name: l.name,
        slug: l.slug,
        country: l.country || null,
        // Per-location feature gate (migration 032). Mobile reads
        // this via canMobile()/canDashboard() so a feature switched
        // off at the user's active location is hidden from every
        // user there regardless of role default.
        features: l.features || {},
        // Per-location user override (migration 058). Empty `{}` →
        // role default applies. Master users have empty here too
        // and short-circuit to true after the location gate.
        permissions: assignmentsByLocation[l.id]?.permissions || {},
      })),
      activeLocation: user.activeLocation
        ? {
            id: user.activeLocation.id,
            name: user.activeLocation.name,
            slug: user.activeLocation.slug,
            country: user.activeLocation.country || null,
            features: user.activeLocation.features || {},
            permissions: user.activeAssignment?.permissions || {},
          }
        : null,
    },
  })
}
