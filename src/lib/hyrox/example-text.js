// HYROX-STYLE — render a generated session into a compact plain-text block used
// as a few-shot "style example". Pure; no JSON, coaching-readable.
export function sessionToExampleText(session) {
  const fs = session?.full_session || {}
  const b = session?.board || {}
  const lines = []
  lines.push(`Week ${session?.week_no} session ${session?.slot} (${session?.phase || ''}) - ${session?.focus || ''}`.trim())
  if (fs.warmup) lines.push(`Warmup: ${fs.warmup}`)
  if (fs.strength) lines.push(`Strength: ${fs.strength}`)
  if (fs.main) lines.push(`Main: ${fs.main}`)
  if (fs.finisher) lines.push(`Finisher: ${fs.finisher}`)
  if (Array.isArray(fs.cues) && fs.cues.length) lines.push(`Cues: ${fs.cues.join('; ')}`)
  if (b.format || b.cap_minutes || b.target) {
    lines.push(`Board: ${[b.format, b.cap_minutes ? `cap ${b.cap_minutes} min` : null, b.target].filter(Boolean).join(' · ')}`)
  }
  if (Array.isArray(b.stations) && b.stations.length) {
    lines.push('Stations:')
    for (const st of b.stations) lines.push(`  ${st.name}: Performance ${st.performance} / Elite ${st.elite}`)
  }
  if (fs.why) lines.push(`Why: ${fs.why}`)
  return lines.join('\n')
}
