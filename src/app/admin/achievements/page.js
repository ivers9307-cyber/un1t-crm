// /admin/achievements — Master-only editor for the data-driven
// achievements rule set.
//
// Server component loads:
//   - the seed list of rules + earned-counts (so the UI can warn
//     before deletion)
//   - event types + locations (for the per-rule-type config dropdowns
//     when adding class_type or first_event:location_visit rules)
//
// All edits go through /api/admin/achievements/* — same shape as
// /admin/audit-log, /admin/matrix.

import { createServerClient } from '@/lib/supabase'
import AchievementsAdminTable from '@/components/AchievementsAdminTable'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function AdminAchievementsPage() {
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
      <p className="text-sm text-un1t-light mb-8 max-w-3xl">
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
