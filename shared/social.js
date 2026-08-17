// KEEP IN SYNC with un1t-crm/src/lib/social.js (verbatim copy below line 1).
// suggestion ranking. No IO. Byte-synced to champ-app/shared/social.js.

export const REACTIONS = [
  { key: 'strong', emoji: '💪', label: 'Strong' },
  { key: 'fire', emoji: '🔥', label: 'Fire' },
  { key: 'clap', emoji: '👏', label: 'Clap' },
  { key: 'wow', emoji: '😮', label: 'Wow' },
]
const REACTION_KEYS = REACTIONS.map((r) => r.key)

export function friendshipPairKey(a, b) {
  return [a, b].sort().join(':')
}

export function friendStatusFor(row, myContactId) {
  if (!row) return null
  if (row.status === 'blocked') return 'blocked'
  if (row.status === 'accepted') return 'friends'
  // pending
  return row.requester_contact_id === myContactId ? 'outgoing' : 'incoming'
}

export function mergeFeed(items) {
  return [...(items || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0))
}

export function reactionSummary(rows, myContactId) {
  const counts = Object.fromEntries(REACTION_KEYS.map((k) => [k, 0]))
  let mine = null
  for (const r of rows || []) {
    if (counts[r.reaction] !== undefined) counts[r.reaction] += 1
    if (r.reactor_contact_id === myContactId) mine = r.reaction
  }
  const total = REACTION_KEYS.reduce((a, k) => a + counts[k], 0)
  return { counts, total, mine }
}

export function rankSuggestions(rows) {
  return [...(rows || [])].sort(
    (a, b) => (b.sharedClasses || 0) - (a.sharedClasses || 0) || String(a.name || '').localeCompare(String(b.name || ''))
  )
}
