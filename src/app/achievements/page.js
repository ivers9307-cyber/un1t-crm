// /achievements — Master-only editor for the data-driven achievements
// rule set.
//
// ADMIN.2h Task 1 — moved out of /admin (was /admin/achievements) into
// the (members) route group so the URL is the clean /achievements —
// this is the master's CATALOGUE editor, distinct from any
// member-facing achievements view. Deliberately NOT added to the
// (members) layout's HubTabs strip (src/app/(members)/layout.js) —
// this is a master-only admin surface, not a member-hub tab a
// non-master member should ever see offered.
//
// FU-COSMETICS amendment — "harmless, just contextual chrome" turned out
// not to be harmless: the strip DID still render above this page for
// whichever other tabs the visiting master holds perms for (Bookings,
// Events, …), so a master editing the achievements catalogue saw an
// unrelated Members hub tab bar with no tab of its own lit and no link
// back to this page — pure noise around an admin table. Escaped to a
// literal tree (src/app/achievements, out of the (members) group) so it
// renders chrome-free, same fix/same reasoning as the event check-in
// subtree and the race-day control console documented in
// src/app/(members)/layout.js's header comment (a phone scan surface and
// a tablet race console — this is a master admin table, same principle:
// a surface the hub's own chrome does nothing for). URL is unchanged —
// route groups are invisible to the router, so /achievements still
// resolves exactly the same.
//
// Server component loads:
//   - the seed list of rules + earned-counts (so the UI can warn
//     before deletion)
//   - event types + locations (for the per-rule-type config dropdowns
//     when adding class_type or first_event:location_visit rules)
//
// All edits go through /api/admin/achievements/* — same shape as
// /settings/audit-log, /admin/matrix (API routes were not moved).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import AchievementsAdminTable from '@/components/AchievementsAdminTable'

export const dynamic = 'force-dynamic'

export default async function AdminAchievementsPage() {
  // STUDIO-GROUP.1 — the /admin layout gate was relaxed to allow
  // non-master users in (for the Studio Management children). This
  // page is still master-only — add an explicit page-level gate so
  // we don't accidentally inherit visibility from the relaxed layout.
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()

  const [rulesRes, eventTypesRes, locationsRes, earnedRes] = await Promise.all([
    db.from('achievement_rules')
      .select('*')
      .order('sort_order', { ascending: true }),
    db.from('event_types')
      .select('id, name, location_id')
      .eq('active', true)
      .order('name'),
    db.from('locations')
      .select('id, name')
      .eq('active', true)
      .eq('is_host_anchor', false)
      .order('name'),
    db.from('contact_achievements').select('rule_id'),
  ])

  const earnedCounts = {}
  for (const r of earnedRes.data || []) {
    earnedCounts[r.rule_id] = (earnedCounts[r.rule_id] || 0) + 1
  }
  const rules = (rulesRes.data || []).map((r) => ({
    ...r,
    earned_count: earnedCounts[r.id] || 0,
  }))

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold mb-1">Achievements</h2>
      <p className="text-sm text-un1t-subtle mb-8 max-w-3xl">
        The badges members can earn. Each rule is data-driven —
        change a threshold without a code change. Rule type and
        config define how detection runs against each session;
        backfill applies a new rule retroactively to all members
        who already qualify. Renaming a rule is fine; deleting one
        will remove all earned instances of it.
      </p>
      <AchievementsAdminTable
        initialRules={rules}
        eventTypes={eventTypesRes.data || []}
        locations={locationsRes.data || []}
      />
    </div>
  )
}
