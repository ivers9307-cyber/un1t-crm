// REPORTS-HUB.1 — pure routing decision for the mobile Reports hub.
//
// One "Reports" tile in the More grid opens the hub. Depending on which
// of the two issue surfaces the user can access, the hub either shows a
// chooser or sends them straight to the single surface they have
// (Richard's design: "if you only have access to 1 feature the button
// should bring you to that only feature, but 2 features I should have a
// choice on what I want to see"). Pure — unit-tested in CI.
//
//   canSubmit — the submit + own-history surface (all staff: `issues`)
//   canTriage — the handler triage inbox (owner/master: `issue_triage`)

/**
 * @returns {'chooser'|'inbox'|'myreports'}
 *   'chooser'   → has both surfaces; show the two-card picker
 *   'inbox'     → triage only; go straight to the handler inbox
 *   'myreports' → submit/own-history only (or the degenerate neither
 *                 case — the tile is access-gated so that shouldn't
 *                 render); go straight to My reports
 */
export function reportsLanding({ canSubmit, canTriage } = {}) {
  if (canSubmit && canTriage) return 'chooser'
  if (canTriage) return 'inbox'
  return 'myreports'
}
