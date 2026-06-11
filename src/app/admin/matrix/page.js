// /admin/matrix — Master-only platform admin view.
//
// Two stacked sections:
//   1. Feature Matrix (editable) — locations × per-location feature
//      gates, grouped by organization. Reuses the toggle pattern from
//      LocationFeatures (mig 032) but shown in a grid instead of one
//      location at a time.
//   2. Access Matrix (read-only in v1) — every staff member × every
//      location, cells show role assignment. Click a row to jump to
//      the existing StaffForm at /settings/staff/[id] for editing.
//      Editable inline in v2.
//
// Data fetching is server-side (this is a server component) so RLS
// reflects the master's full visibility. The components themselves
// are client components for the interactive bits.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Building2 } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import AdminFeatureMatrix from '@/components/AdminFeatureMatrix'
import AdminAccessMatrix from '@/components/AdminAccessMatrix'
import AddOrganizationButton from '@/components/AddOrganizationButton'

export const dynamic = 'force-dynamic'

export default async function AdminMatrixPage() {
  // STUDIO-GROUP.1 — page-level master gate (layout relaxed).
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()

  const [orgsRes, locsRes, staffRes] = await Promise.all([
    db.from('organizations').select('*').eq('active', true).order('name'),
    db.from('locations').select('*').eq('active', true).order('name'),
    db
      .from('profiles')
      .select(`
        id, full_name, email, role, active,
        profile_locations ( location_id, role, is_default )
      `)
      .eq('active', true)
      .order('full_name'),
  ])

  const organizations = orgsRes.data || []
  const locations = locsRes.data || []
  const staff = staffRes.data || []

  // Group locations by organization for both matrix renders. We do
  // this once here in the server component so both child components
  // get the same shape and the grouping logic isn't duplicated.
  const locationsByOrg = {}
  for (const org of organizations) locationsByOrg[org.id] = []
  for (const loc of locations) {
    if (loc.organization_id && locationsByOrg[loc.organization_id]) {
      locationsByOrg[loc.organization_id].push(loc)
    }
  }

  // Organizations with no locations are skipped by both matrices (their
  // rows/columns are location-driven), which makes a freshly created org
  // look like the creation silently failed — and users can't be assigned
  // to it because assignments attach to locations, not orgs. Surface
  // them explicitly with the next step instead of hiding them.
  const emptyOrgs = organizations.filter((org) => (locationsByOrg[org.id] || []).length === 0)

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <h2 className="text-2xl font-bold">Platform admin</h2>
        <AddOrganizationButton />
      </div>
      <p className="text-sm text-un1t-subtle mb-8">
        Master-only view across every organization, location, and user. Feature toggles edit
        inline; user assignments are managed via the access matrix.
      </p>

      {emptyOrgs.length > 0 && (
        <div className="mb-8 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-500/10 px-4 py-3 text-sm">
          <Building2 size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold text-amber-800">
              {emptyOrgs.map((o) => o.name).join(', ')}{' '}
              {emptyOrgs.length === 1 ? 'has' : 'have'} no locations yet
            </p>
            <p className="mt-0.5 text-amber-700">
              An organisation appears in the matrices below once it has a location — and users
              are assigned to locations, not organisations.{' '}
              <Link
                href="/settings/locations/new"
                className="font-medium underline hover:no-underline"
              >
                Add the first location
              </Link>{' '}
              to start assigning users and configuring features.
            </p>
          </div>
        </div>
      )}

      <section className="mb-12">
        <h3 className="text-lg font-semibold mb-1">Feature matrix</h3>
        <p className="text-xs text-un1t-subtle mb-4">
          Each cell is the per-location feature gate. Toggle off and that feature disappears
          from the sidebar (and mobile tab bar) for every user at that location, regardless of
          role default. Notification preferences (notify_*) stay personal and aren&apos;t shown.
        </p>
        <AdminFeatureMatrix
          organizations={organizations}
          locationsByOrg={locationsByOrg}
        />
      </section>

      <section>
        <h3 className="text-lg font-semibold mb-1">Access matrix</h3>
        <p className="text-xs text-un1t-subtle mb-4">
          Who has access to what, across every location. Cells show the per-location role; click
          a row to edit assignments via the existing staff editor. Master users (platform admins)
          are flagged with the badge on the right — they see everything regardless of per-location
          assignments.
        </p>
        <AdminAccessMatrix
          organizations={organizations}
          locationsByOrg={locationsByOrg}
          staff={staff}
        />
      </section>
    </div>
  )
}
