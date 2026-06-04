// PILLAR2 Phase 1 — pure compose helpers shared by the unified send surface
// (UnifiedSendComposer). Mirrors the proven bits of the SMS + WhatsApp broadcast
// editors so the unified surface stays consistent with the existing send paths.
// Pure — no IO, unit-tested in compose.test.js.

// --- SMS -------------------------------------------------------------------

// Hard cap on an SMS body (matches the sms_broadcasts.body CHECK constraint).
export const SMS_MAX_LEN = 1600

// Merge tags the SMS send path (postmark.applyMergeTags) resolves per-recipient.
export const SMS_MERGE_TAGS = [
  { tag: '{{first_name}}', label: 'First name' },
  { tag: '{{name}}', label: 'Full name' },
  { tag: '{{location_name}}', label: 'Location' },
]

// GSM-7 segment math (mirrors SMSBroadcastEditor): a single SMS holds 160 chars;
// concatenated SMS use 153 chars/segment (7 lost to the UDH header per segment).
export function smsSegmentInfo(text) {
  const len = (text || '').length
  if (len === 0) return { len: 0, segments: 0 }
  if (len <= 160) return { len, segments: 1 }
  return { len, segments: Math.ceil(len / 153) }
}

// --- WhatsApp --------------------------------------------------------------

// Contact fields an operator can map a template variable to (resolved by
// whatsapp.buildTemplateComponents at send time; anything else is sent literally).
export const WA_VARIABLE_FIELDS = ['first_name', 'name', 'email', 'phone', 'location_name']

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
