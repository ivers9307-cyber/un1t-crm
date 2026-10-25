// PILLAR2 Phase 1 — pure compose helpers shared by the unified send surface
// (UnifiedSendComposer). Mirrors the proven bits of the WhatsApp broadcast
// editor so the unified surface stays consistent with the existing send path.
// Pure — no IO, unit-tested in compose.test.js.

// --- WhatsApp --------------------------------------------------------------

// Contact fields an operator can map a template variable to (resolved by
// whatsapp.buildTemplateComponents at send time; anything else is sent literally).
// W1.S3 — company_name is the location's resolved brand, the same tag email
// offers; location_name renders the brand too (its historical meaning on
// WhatsApp), falling back to the studio's own label.
export const WA_VARIABLE_FIELDS = ['first_name', 'name', 'email', 'phone', 'location_name', 'company_name']

// Pull {{1}}, {{2}}… placeholders out of a WhatsApp template's BODY component so
// we can render one mapping input per variable. Deduped + numerically sorted.
// (Pure twin of whatsappBodyVariables in sequences/nodeEditing.jsx.)
export function waBodyVariables(template) {
  if (!template) return []
  const body = (template.components || []).find(c => c.type === 'BODY')
  if (!body?.text) return []
  const matches = body.text.match(/\{\{\d+\}\}/g) || []
  const set = new Set(matches.map(m => m.match(/\d+/)[0]))
  return [...set].sort((a, b) => Number(a) - Number(b))
}
