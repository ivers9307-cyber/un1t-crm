// POLICIES.1 + POLICIES-VIEWS.1 — server-side helpers for the
// policies hub. Acknowledgement model (mig 178) was replaced with
// passive view tracking (mig 179) — a user is "viewed" a policy
// version if at least one completed (ended_at IS NOT NULL) view row
// exists for that (profile_id, policy_version_id).
//
// Public surface:
//   - listPoliciesWithStatus(user)   for the staff /policies page
//   - getPolicyBySlug(slug, user)    for the /policies/[slug] page
//   - outstandingPolicyCount(user)   for the banner badge
//   - listVersions(policyId)         for the admin version list
//   - publishVersion(...)            admin publish flow
//   - sectionDwellAggregate(versionId)  admin "hot sections" report
//   - listVersionViewers(versionId)   admin per-version viewer list

import { createServerClient } from '@/lib/supabase'

/**
 * Returns all active policies with their current version metadata
 * and whether the given user has viewed (i.e. has at least one
 * COMPLETED view of) that version.
 *
 *   [{ id, slug, title, description, display_order,
 *      current_version: { id, version_number, effective_date,
 *                         published_at, change_summary, body_markdown },
 *      viewed_at: timestamptz | null,    // most recent completed view
 *      view_count: number }]
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

  // Fetch the user's completed views for those versions. Group
  // client-side for speed (small N).
  let viewsByVersionId = new Map()
  if (versionIds.length > 0) {
    const { data: views, error: viewsErr } = await db
      .from('policy_views')
      .select('policy_version_id, ended_at')
      .eq('profile_id', user.id)
      .in('policy_version_id', versionIds)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
    if (viewsErr) throw viewsErr
    for (const v of views || []) {
      const cur = viewsByVersionId.get(v.policy_version_id) || { latest: null, count: 0 }
      cur.count += 1
      if (!cur.latest || v.ended_at > cur.latest) cur.latest = v.ended_at
      viewsByVersionId.set(v.policy_version_id, cur)
    }
  }

  return (policies || []).map((p) => {
    const current = (p.policy_versions || []).find((v) => v.is_current) || null
    const viewInfo = current ? viewsByVersionId.get(current.id) || null : null
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
      viewed_at: viewInfo?.latest || null,
      view_count: viewInfo?.count || 0,
    }
  })
}

/**
 * Single policy lookup with the calling user's view status. Returns
 * null if the policy is missing or inactive.
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

  let viewed_at = null
  let view_count = 0
  if (current && user?.id) {
    const { data: views } = await db
      .from('policy_views')
      .select('ended_at')
      .eq('policy_version_id', current.id)
      .eq('profile_id', user.id)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
    view_count = (views || []).length
    viewed_at = views?.[0]?.ended_at || null
  }

  return {
    id: policy.id,
    slug: policy.slug,
    title: policy.title,
    description: policy.description,
    current_version: current,
    viewed_at,
    view_count,
  }
}

/**
 * Policies the user has not yet opened (no completed view of the
 * current version). Drives the badge in the More tab and banner.
 */
export async function outstandingPolicyCount(user) {
  if (!user?.id) return 0
  const policies = await listPoliciesWithStatus(user)
  return policies.filter((p) => p.current_version && !p.viewed_at).length
}

/**
 * Admin: full version history for a single policy. Returns versions
 * descending (newest first) with completed view counts.
 */
export async function listVersions(policyId) {
  const db = createServerClient()
  const { data: versions, error } = await db
    .from('policy_versions')
    .select(`
      id, version_number, change_summary, effective_date,
      published_at, published_by, is_current,
      policy_views ( id, ended_at )
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
    completed_view_count: (v.policy_views || []).filter((vw) => !!vw.ended_at).length,
  }))
}

/**
 * Admin: per-version viewer summary. Returns one row per profile
 * who's viewed at least once, with their session count, total time
 * across sessions, and most-recent view timestamp. Plus the list of
 * staff who haven't viewed.
 */
export async function listVersionViewers(versionId) {
  const db = createServerClient()
  const [viewsRes, staffRes] = await Promise.all([
    db.from('policy_views')
      .select(`
        profile_id, started_at, ended_at, total_duration_seconds,
        section_dwell, viewed_via,
        profiles!profile_id ( full_name, email )
      `)
      .eq('policy_version_id', versionId)
      .order('started_at', { ascending: false }),
    db.from('profiles')
      .select('id, full_name, email')
      .eq('active', true)
      .order('full_name'),
  ])

  const views = viewsRes.data || []
  const completed = views.filter((v) => v.ended_at)

  // Group by profile.
  const byProfile = new Map()
  for (const v of completed) {
    const cur = byProfile.get(v.profile_id) || {
      profile_id: v.profile_id,
      full_name: v.profiles?.full_name || null,
      email: v.profiles?.email || null,
      session_count: 0,
      total_seconds: 0,
      latest_at: null,
      latest_via: null,
    }
    cur.session_count += 1
    cur.total_seconds += v.total_duration_seconds || 0
    if (!cur.latest_at || v.started_at > cur.latest_at) {
      cur.latest_at = v.started_at
      cur.latest_via = v.viewed_via
    }
    byProfile.set(v.profile_id, cur)
  }

  const viewers = [...byProfile.values()].sort((a, b) =>
    (b.latest_at || '').localeCompare(a.latest_at || ''))

  const viewedIds = new Set(viewers.map((v) => v.profile_id))
  const outstanding = (staffRes.data || []).filter((s) => !viewedIds.has(s.id))

  return { viewers, outstanding, all_views: views }
}

/**
 * Admin "hot sections" aggregate. Sums section_dwell across every
 * completed view of the given version and returns an array of
 * `{ section, total_seconds, avg_seconds, sessions }` sorted by
 * total_seconds desc. Sessions is the number of unique view
 * sessions that touched that section (dwell > 0).
 *
 * If no completed views exist or no section_dwell was reported,
 * returns [].
 */
export async function sectionDwellAggregate(versionId) {
  const db = createServerClient()
  const { data: views } = await db
    .from('policy_views')
    .select('section_dwell')
    .eq('policy_version_id', versionId)
    .not('ended_at', 'is', null)
    .not('section_dwell', 'is', null)

  const agg = new Map()
  for (const v of views || []) {
    const dwell = v.section_dwell || {}
    for (const [section, secsRaw] of Object.entries(dwell)) {
      const secs = Number(secsRaw)
      if (!Number.isFinite(secs) || secs <= 0) continue
      const cur = agg.get(section) || { section, total_seconds: 0, sessions: 0 }
      cur.total_seconds += secs
      cur.sessions += 1
      agg.set(section, cur)
    }
  }
  return [...agg.values()]
    .map((r) => ({ ...r, avg_seconds: Math.round(r.total_seconds / r.sessions) }))
    .sort((a, b) => b.total_seconds - a.total_seconds)
}

/**
 * Admin publish-new-version flow. Race-safe via the partial unique
 * index on (policy_id) where is_current.
 */
export async function publishVersion({ policyId, bodyMarkdown, changeSummary, effectiveDate, publishedBy }) {
  const db = createServerClient()

  const { data: prevRows } = await db
    .from('policy_versions')
    .select('version_number')
    .eq('policy_id', policyId)
    .order('version_number', { ascending: false })
    .limit(1)
  const nextVersion = (prevRows?.[0]?.version_number || 0) + 1

  const { error: flipErr } = await db
    .from('policy_versions')
    .update({ is_current: false })
    .eq('policy_id', policyId)
    .eq('is_current', true)
  if (flipErr) throw flipErr

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

// --------------------------------------------------------------------
// Section-detection helper.
//
// Given the body markdown of a policy, return an ordered array of
// section heading strings. We treat a line as a section heading if
// it matches either:
//   - a numbered heading like "1. PURPOSE AND SCOPE" (the AUP /
//     Privacy Notice style), or
//   - an ALL-CAPS line of >= 5 non-whitespace chars (the Handbook /
//     contract-template style).
// Surrounded by blank lines is a strong tell — we require the next
// line to be blank.
//
// This is exported for the client to share the same detection logic
// as any server-side report code.
// --------------------------------------------------------------------

export function detectSectionHeadings(bodyMarkdown) {
  if (!bodyMarkdown) return []
  const lines = bodyMarkdown.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const next = (lines[i + 1] || '').trim()
    if (next !== '') continue  // heading must be followed by blank line

    // Numbered heading: 1. SOMETHING IN CAPS or 1. Something
    if (/^\d+\.\s+\S/.test(line)) {
      // accept "1. Title" — most numbered headings are title-case
      out.push(line)
      continue
    }
    // ALL-CAPS heading: at least 5 chars, no lowercase letters
    const noLower = !/[a-z]/.test(line)
    const hasAlpha = /[A-Z]/.test(line)
    if (noLower && hasAlpha && line.replace(/\s+/g, '').length >= 5) {
      out.push(line)
    }
  }
  return out
}
