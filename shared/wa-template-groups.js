// Grouping + search for WhatsApp template pickers (mig 450 display_group).
// Shared so the web inbox picker, the templates list page and the mobile
// picker sheet can never disagree on bucketing or ordering.

export const UNGROUPED_LABEL = 'Ungrouped'

// Body preview text — web rows carry Meta `components`, the mobile select
// reads the denormalised `body_text` column. Accept either shape.
export function templateBodyText(t) {
  if (typeof t?.body_text === 'string' && t.body_text) return t.body_text
  const body = Array.isArray(t?.components) ? t.components.find(c => c?.type === 'BODY') : null
  return typeof body?.text === 'string' ? body.text : ''
}

// Distinct group labels currently in use (for datalist suggestions),
// alphabetical, first-seen casing wins for case-insensitive duplicates.
export function listWaTemplateGroups(templates) {
  const seen = new Map()
  for (const t of templates || []) {
    const label = typeof t?.display_group === 'string' ? t.display_group.trim() : ''
    if (!label) continue
    const key = label.toLowerCase()
    if (!seen.has(key)) seen.set(key, label)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// Filter by `search` (matches name, group label or body text, case-
// insensitive), then bucket by display_group. Groups come back sorted
// alphabetically with Ungrouped last; templates sorted by name within
// each group. Returns [{ label, templates }].
export function groupWaTemplates(templates, search = '') {
  const q = typeof search === 'string' ? search.trim().toLowerCase() : ''
  const byKey = new Map()
  for (const t of templates || []) {
    if (q) {
      const haystack = [t?.name, t?.display_group, templateBodyText(t)]
      if (!haystack.some(v => typeof v === 'string' && v.toLowerCase().includes(q))) continue
    }
    const trimmed = typeof t?.display_group === 'string' ? t.display_group.trim() : ''
    const label = trimmed || UNGROUPED_LABEL
    const key = label.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, { label, templates: [] })
    byKey.get(key).templates.push(t)
  }
  const groups = [...byKey.values()]
  for (const g of groups) {
    g.templates.sort((a, b) => (a?.name || '').localeCompare(b?.name || ''))
  }
  groups.sort((a, b) => {
    const aLast = a.label.toLowerCase() === UNGROUPED_LABEL.toLowerCase()
    const bLast = b.label.toLowerCase() === UNGROUPED_LABEL.toLowerCase()
    if (aLast !== bLast) return aLast ? 1 : -1
    return a.label.localeCompare(b.label)
  })
  return groups
}
