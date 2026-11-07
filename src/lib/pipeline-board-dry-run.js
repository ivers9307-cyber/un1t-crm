// PIPEBUILD.5e — shape a dry-run result for one offer board: how many people
// would enter, how they spread across its stages, and which other boards they
// would come from. Pure; the route runs reclassifyAllContacts and passes the
// result in.

/**
 * @param {object} result  a dry-run reclassifyAllContacts result
 * @param {{ key: string, stages?: Array<{slug: string, name: string, display_order?: number}> }} board
 * @param {Record<string, string>} [boardNames]  { boardKey: name } for naming overlap rows
 */
export function summariseBoardDryRun(result, board, boardNames = {}) {
  const stageCounts = result?.stage_histogram || {}
  const stages = [...(board?.stages || [])].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
  const byStage = stages.map((s) => ({ slug: s.slug, name: s.name, count: stageCounts[s.slug] ?? 0 }))

  const from = result?.board_overlap?.[board.key] || {}
  const overlap = Object.entries(from)
    .map(([boardKey, count]) => ({
      boardKey,
      ...(boardNames[boardKey] ? { boardName: boardNames[boardKey] } : {}),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.boardKey.localeCompare(b.boardKey))

  return {
    entering: result?.board_histogram?.[board.key] ?? 0,
    byStage,
    overlap,
    contactsSeen: result?.contacts_seen ?? 0,
    errors: result?.errors ?? 0,
  }
}
