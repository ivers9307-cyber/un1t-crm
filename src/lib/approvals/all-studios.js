// APPROVALSQ.6 — the opt-in "All my studios" approvals list.
//
// The list is exactly the union of what the person would see by switching
// into each of their studios in turn: for every studio in user.locations we
// build the user getCurrentUser() would have returned there
// (userAtLocation) and run the existing registry with it. No provider
// changes, so nothing about who may see what changes. Every item is tagged
// with the studio it was listed under, so the page can send each decision
// with that studio's x-active-location header (see
// docs/superpowers/specs/2026-11-15-approvals-all-studios-design.md).

import { getPendingApprovals } from './registry.js'
import { userAtLocation } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const DEFAULT_MAX_STUDIOS = 12

const defaultDeps = { getPendingApprovals, userAtLocation, hasPermission }

/**
 * Studios the person could open /approvals at (the page's own gate:
 * approvals_inbox on the derived user), active studio first, then by name,
 * capped. Runs no provider.
 *
 * @returns {{ studios: Array<{id, name}>, derived: Map<string, object>, truncated: boolean }}
 */
function eligible(user, maxStudios, deps) {
  const activeId = user?.activeLocation?.id
  const rows = []
  for (const loc of user?.locations || []) {
    const derived = deps.userAtLocation(user, loc.id)
    if (!derived || !deps.hasPermission(derived, 'approvals_inbox')) continue
    rows.push({ id: loc.id, name: loc.name || '', derived })
  }
  rows.sort((a, b) => {
    if (a.id === activeId) return -1
    if (b.id === activeId) return 1
    return a.name.localeCompare(b.name)
  })
  const cap = Number.isInteger(maxStudios) && maxStudios > 0 ? maxStudios : DEFAULT_MAX_STUDIOS
  const kept = rows.slice(0, cap)
  return {
    studios: kept.map(({ id, name }) => ({ id, name })),
    derived: new Map(kept.map((r) => [r.id, r.derived])),
    truncated: rows.length > kept.length,
  }
}

/** The eligible studios without running any provider (the default response's `studios`). */
export function listEligibleStudios(user, { maxStudios = DEFAULT_MAX_STUDIOS } = {}, deps = defaultDeps) {
  const { studios, truncated } = eligible(user, maxStudios, { ...defaultDeps, ...deps })
  return { studios, truncated }
}

const tag = (item, studio) => ({ ...item, studioId: studio.id, studioName: studio.name })

export async function getPendingApprovalsAllStudios(db, user, { maxStudios = DEFAULT_MAX_STUDIOS } = {}, depsIn = defaultDeps) {
  const deps = { ...defaultDeps, ...depsIn }
  const { studios, derived, truncated } = eligible(user, maxStudios, deps)

  const settled = await Promise.allSettled(
    studios.map((s) => deps.getPendingApprovals(db, derived.get(s.id)))
  )

  const failedStudios = []
  const unavailable = [] // APPROVALSUNAVAIL.1 — "<category> at <studio>"
  const merged = new Map() // provider key -> merged provider, insertion = display order
  const seenItems = new Set()
  const seenFailed = new Set()

  // Studio order is active first, so "first seen" is the active studio's copy
  // whenever there is one, and the registry order is the active studio's.
  settled.forEach((res, i) => {
    const studio = studios[i]
    if (res.status !== 'fulfilled') {
      failedStudios.push(studio.name)
      console.warn(`[approvals] all-studios: studio '${studio.id}' failed: ${res.reason?.message || res.reason}`)
      return
    }
    for (const p of res.value?.providers || []) {
      let m = merged.get(p.key)
      if (!m) {
        m = { key: p.key, label: p.label, reviewBase: p.reviewBase, count: 0, items: [], failedItems: [] }
        merged.set(p.key, m)
      }
      if (p.unavailable) {
        m.unavailable = true
        unavailable.push(`${p.label} at ${studio.name}`)
      }
      const take = (src, dst, seen) => {
        for (const item of src || []) {
          if (item?.id != null) {
            const k = `${p.key}\u0000${item.id}`
            if (seen.has(k)) continue
            seen.add(k)
          }
          dst.push(tag(item, studio))
        }
      }
      take(p.items, m.items, seenItems)
      take(p.failedItems, m.failedItems, seenFailed)
    }
  })

  const providers = [...merged.values()].map((m) => ({ ...m, count: m.items.length + m.failedItems.length }))
  const total = providers.reduce((sum, p) => sum + p.count, 0)
  return { providers, total, scope: 'all', studios, failedStudios, truncated, unavailable }
}
