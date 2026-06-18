// SESSION-REPORT.2 — class category helpers (un1t-crm only). The match key
// (normalizeClassName) lives in hr-analytics.js so the report builder, the
// loaders, and this settings surface all derive the same key.

import { normalizeClassName } from '@/lib/hr-analytics'

export const CLASS_CATEGORY_VALUES = ['cardio', 'strength', 'conditioning']

/**
 * Merge a list of seen class-name strings with the saved mappings into the
 * settings-page shape: one row per distinct normalized name, category attached
 * (null when unmapped). Mapped-but-not-seen names are included so an operator
 * can re-categorise a class that's gone quiet. Pure.
 * @returns {Array<{ class_name: string, category: string|null }>}
 */
export function mergeSeenWithMappings(seenNames = [], mappings = []) {
  const catByKey = new Map((mappings || []).map((m) => [m.class_name_normalized, m.category]))
  const display = new Map() // normalized -> display name

  for (const raw of seenNames || []) {
    const key = normalizeClassName(raw)
    if (!key) continue
    if (!display.has(key)) display.set(key, String(raw).trim())
  }
  // Mapped-but-unseen: synthesize a display name from the normalized key.
  for (const [key] of catByKey) {
    if (!display.has(key)) display.set(key, key)
  }

  return [...display.entries()]
    .map(([key, name]) => ({ class_name: name, category: catByKey.get(key) ?? null }))
    .sort((a, b) => a.class_name.localeCompare(b.class_name))
}

/**
 * Load the seen class names (heart_rate_sessions.class_name ∪ class_occurrences.name)
 * at a location, merged with saved mappings. The distinct set of class names is
 * tiny, so the per-table 1000-row cap captures every name in practice.
 */
export async function loadSeenClassCategories(db, locationId) {
  const [{ data: hrRows }, { data: occRows }, { data: mappings }] = await Promise.all([
    db.from('heart_rate_sessions').select('class_name').eq('location_id', locationId).not('class_name', 'is', null).limit(1000),
    db.from('class_occurrences').select('name').eq('location_id', locationId).limit(1000),
    db.from('class_categories').select('class_name_normalized, category').eq('location_id', locationId),
  ])
  const seen = [
    ...(hrRows || []).map((r) => r.class_name),
    ...(occRows || []).map((r) => r.name),
  ].filter(Boolean)
  return mergeSeenWithMappings(seen, mappings || [])
}
