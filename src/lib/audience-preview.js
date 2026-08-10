// FILTER-B.5 — shaping and masking for the audience preview.
//
// The preview exists so an operator can check WHO a filter selects without
// sending to it. That means showing enough to recognise a person and nothing
// more: the name in full, one identifier masked, the funnel stage for context.
// It is emphatically NOT an export — an export of a marketing audience is a
// different feature with different consent implications, and building one here
// by accident (a full email column, a copyable list) is the failure mode this
// module is shaped to prevent. toPreviewRow is a WHITELIST: it constructs a
// fresh object, so a column added to the query later cannot leak through.

export const PREVIEW_PAGE_SIZE = 50
// Hard ceiling on ?limit. The point of a preview is a spot-check; a caller
// asking for thousands of masked rows is building an export by another name.
export const PREVIEW_MAX_PAGE_SIZE = 50

const DOTS = '•••'

/**
 * `richard@example.com` → `ri•••@example.com`.
 * The DOMAIN is kept deliberately: a preview full of the wrong domain is how
 * an operator spots a mis-targeted audience at a glance.
 */
export function maskEmail(email) {
  const s = String(email ?? '').trim()
  if (!s || !s.includes('@')) return null
  const at = s.lastIndexOf('@')
  const local = s.slice(0, at)
  const domain = s.slice(at + 1)
  if (!local || !domain) return null
  const keep = local.length > 2 ? 2 : local.length > 1 ? 1 : 0
  return `${local.slice(0, keep)}${DOTS}@${domain}`
}

/**
 * `+353871234567` → `•••• 4567`. Last four digits only — the amount a person
 * recognises about their own number and the amount that is useless as a list.
 */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length < 4) return '••••'
  return `•••• ${digits.slice(-4)}`
}

// The identifier column each channel actually delivers to. wa_phone is NOT
// contacts.phone — they differ for a real slice of the base (see the
// wa-broadcast-reachability lesson), so previewing `phone` for a WhatsApp
// send would show a different audience than the one Meta will message.
const IDENTIFIER_BY_CHANNEL = {
  email: ['email', 'email'],
  sms: ['phone', 'phone'],
  whatsapp: ['wa_phone', 'wa_phone'],
}

function displayName(row) {
  const joined = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim()
  return (row?.name || '').trim() || joined || '(no name)'
}

/**
 * One audience row → the only four things the preview is allowed to show.
 * @param {object} row      a row from the per-channel eligibility query
 * @param {string|null} channel
 */
export function toPreviewRow(row, channel) {
  // No channel = a sequence's match set. There is no delivery channel to name,
  // so the email address is used as the human handle (still masked).
  const [column, kind] = IDENTIFIER_BY_CHANNEL[channel] || IDENTIFIER_BY_CHANNEL.email
  const raw = row?.[column]
  return {
    id: row?.id ?? null,
    name: displayName(row),
    stage: row?.pipeline_stage_slug ?? null,
    identifier: kind === 'email' ? maskEmail(raw) : maskPhone(raw),
    identifier_kind: kind,
  }
}

// The columns the preview query needs — the smallest set that feeds
// toPreviewRow. Anything not listed here never leaves the database.
export const PREVIEW_COLUMNS = 'id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug'
