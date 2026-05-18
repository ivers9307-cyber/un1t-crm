// POLICIES.1 — server-side helpers for the policies hub.
//
// Single source of truth for the queries the policy pages use:
//   - listPoliciesWithStatus(user)   for the staff /policies page
//   - getPolicyBySlug(slug)          for the staff /policies/[slug] page
//   - outstandingPolicyCount(user)   for the unread-policies banner
//   - listVersions(policyId)         for the admin version history
//   - publishVersion(...)            for the admin publish-new-version
//
// Keeps the route handlers thin and gives us a single place to test
// the "current version + ack status" join logic.

import { createServerClient } from '@/lib/supabase'

/**
 * Returns all active policies with their current version metadata
 * and whether the given user has acknowledged that version.
 *
 *   [{ id, slug, title, description, display_order,
 *      current_version: { id, version_number, effective_date,
 *                         published_at, change_summary, body_markdown },
 *      acknowledged_at: timestamptz | null }]
 *
 * Sorted by display_order then title.
 */
export async function listPoliciesWithStatus(user) {
  if (!user?.id) return []
  const db = createServerClient()

  const { data: policies, error: policiesErr } = await db
    .from('policies')
    .select(`
      id, slug, title, description, display_order,
      policy_versions ( id, version_number, body_markdown, change_summary,
                        effective_date, published_at, is_current )
    `)
    .eq('active', true)
    .order('display_order')
    .order('title')
  if (policiesErr) throw policiesErr

  const versionIds = (policies || [])
    .map((p) => (p.policy_versions || []).find((v) => v.is_current)?.id)
    .filter(Boolean)

  let acksByVersionId = new Map()
  if (versionIds.length > 0) {
    const { data: acks, error: acksErr } = await db
      .from('policy_acknowledgements')
      .select('policy_version_id, acknowledged_at')
      .eq('profile_id', user.id)
      .in('policy_version_id', versionIds)
    if (acksErr) throw acksErr
    acksByVersionId = new Map((acks || []).map((a) => [a.policy_version_id, a.acknowledged_at]))
  }

  return (policies || []).map((p) => {
    const current = (p.policy_versions || []).find((v) => v.is_current) || null
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      display_order: p.display_order,
      current_version: current
        ? {
            id: current.id,
            version_number: current.version_number,
            body_markdown: current.body_markdown,
            change_summary: current.change_summary,
            effective_date: current.effective_date,
            published_at: current.published_at,
          }
        : null,
      acknowledged_at: current ? acksByVersionId.get(current.id) || null : null,
    }
  })
}

/**
 * Returns a single active policy by slug with its current version
 * and the calling user's ack status for that version. Returns null
 * if the policy doesn't exist or is inactive.
 */
export async function getPolicyBySlug(slug, user) {
  if (!slug) return null
  const db = createServerClient()

  const { data: policy, error } = await db
    .from('policies')
    .select(`
      id, slug, title, description,
      policy_versions ( id, version_number, body_markdown, change_summary,
                        effective_date, published_at, is_current )
    `)
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  if (!policy) return null

  const current = (policy.policy_versions || []).find((v) => v.is_current) || null

  let acknowledged_at = null
  if (current && user?.id) {
    const { data: ack } = await db
      .from('policy_acknowledgements')
      .select('acknowledged_at')
      .eq('policy_version_id', current.id)
      .eq('profile_id', user.id)
      .maybeSingle()
    acknowledged_at = ack?.acknowledged_at || null
  }

  return {
    id: policy.id,
    slug: policy.slug,
    title: policy.title,
    description: policy.description,
    current_version: current,
    acknowledged_at,
  }
}

/**
 * How many policies does this user have outstanding (active policies
 * whose current version they have NOT acknowledged)? Powers the
 * unread-policies banner.
 *
 * Defensive on null user — returns 0 (no banner).
 */
export async function outstandingPolicyCount(user) {
  if (!user?.id) return 0
  // Reuse listPoliciesWithStatus to keep the join logic in one place.
  // Cheap: 3 small tables, indexed lookups.
  const policies = await listPoliciesWithStatus(user)
  return policies.filter((p) => p.current_version && !p.acknowledged_at).length
}

/**
 * Admin: full version history for a single policy. Returns versions
 * in descending order (newest first) with ack counts.
 */
export async function listVersions(policyId) {
  const db = createServerClient()
  const { data: versions, error } = await db
    .from('policy_versions')
    .select(`
      id, version_number, change_summary, effective_date,
      published_at, published_by, is_current,
      policy_acknowledgements ( id )
    `)
    .eq('policy_id', policyId)
    .order('version_number', { ascending: false })
  if (error) throw error
  return (versions || []).map((v) => ({
    id: v.id,
    version_number: v.version_number,
    change_summary: v.change_summary,
    effective_date: v.effective_date,
    published_at: v.published_at,
    published_by: v.published_by,
    is_current: v.is_current,
    ack_count: (v.policy_acknowledgements || []).length,
  }))
}

/**
 * Admin: publish a new version of a policy. Transactionally:
 *   1. flip the previous is_current to false
 *   2. compute the next version_number = max(existing) + 1
 *   3. insert the new row with is_current = true
 *
 * Done via two sequential writes because Supabase JS doesn't expose
 * a transactional helper here; the partial unique index on
 * (policy_id) where is_current = true means a race would fail-closed
 * (the second writer's INSERT would violate the unique constraint),
 * which is the safe direction.
 */
export async function publishVersion({ policyId, bodyMarkdown, changeSummary, effectiveDate, publishedBy }) {
  const db = createServerClient()

  // Compute next version_number.
  const { data: prevRows } = await db
    .from('policy_versions')
    .select('version_number')
    .eq('policy_id', policyId)
    .order('version_number', { ascending: false })
    .limit(1)
  const nextVersion = (prevRows?.[0]?.version_number || 0) + 1

  // Flip previous current → false.
  const { error: flipErr } = await db
    .from('policy_versions')
    .update({ is_current: false })
    .eq('policy_id', policyId)
    .eq('is_current', true)
  if (flipErr) throw flipErr

  // Insert new current.
  const { data: inserted, error: insertErr } = await db
    .from('policy_versions')
    .insert({
      policy_id: policyId,
      version_number: nextVersion,
      body_markdown: bodyMarkdown,
      change_summary: changeSummary || null,
      effective_date: effectiveDate,
      published_by: publishedBy,
      is_current: true,
    })
    .select('id, version_number')
    .single()
  if (insertErr) throw insertErr

  return inserted
}
