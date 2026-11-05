// MIASETTINGS.3c — which knowledge entries the Knowledge section lists for a
// search and a category. The query matches title and content (case-insensitive,
// trimmed); an empty query matches all. `category` is one of the section's
// categories, or '' for all.

export function filterKnowledge(entries, { query = '', category = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  return (entries || []).filter((e) => {
    if (category && e.category !== category) return false
    if (!q) return true
    return [e.title, e.content].some((s) => String(s || '').toLowerCase().includes(q))
  })
}
