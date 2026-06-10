// src/lib/whatsapp-template-events.js
// WA-TMPL — pure helpers for the WhatsApp template webhooks. No IO (the
// applyTemplateEvent IO wrapper lives below, but these three are pure + unit-tested).
// Events: message_template_status_update / _quality_update / template_category_update.

const NOTIFY_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'LIMIT_EXCEEDED'])
const NOTIFY_QUALITY = new Set(['YELLOW', 'RED'])

function cleanReason(reason) {
  return reason && reason !== 'NONE' ? reason : null
}

// Webhook field+value → the whatsapp_templates column patch (or null for an unknown field).
export function templateColumnUpdate(field, value) {
  switch (field) {
    case 'message_template_status_update':
      return { status: value.event, rejection_reason: cleanReason(value.reason) }
    case 'message_template_quality_update':
      return { quality_rating: value.new_quality_score }
    case 'template_category_update':
      return { category: value.new_category }
    default:
      return null
  }
}

// Notification policy → { title, body } to push, or null to stay silent.
export function templateNotification(field, value, templateName) {
  const name = templateName || value.message_template_name || 'a template'
  const lang = value.message_template_language ? ` (${value.message_template_language})` : ''
  switch (field) {
    case 'message_template_status_update': {
      if (!NOTIFY_STATUSES.has(value.event)) return null
      if (value.event === 'APPROVED') return { title: 'Template approved', body: `✅ '${name}'${lang} approved` }
      if (value.event === 'REJECTED') {
        const r = cleanReason(value.reason)
        return { title: 'Template rejected', body: `❌ '${name}' rejected${r ? ` — ${r}` : ''}` }
      }
      return { title: 'Template paused', body: `⏸ '${name}' ${value.event.toLowerCase().replace('_', ' ')} by Meta` }
    }
    case 'message_template_quality_update': {
      if (!NOTIFY_QUALITY.has(value.new_quality_score)) return null
      return { title: 'Template quality dropped', body: `⚠️ '${name}' quality dropped to ${value.new_quality_score} — Meta may pause it` }
    }
    case 'template_category_update': {
      if (value.new_category === value.previous_category) return null
      return { title: 'Template re-categorised', body: `ℹ️ '${name}' re-categorised ${value.previous_category} → ${value.new_category}` }
    }
    default:
      return null
  }
}

// Webhook field+value → the whatsapp_template_events audit row (kind/from/to/reason), or null.
export function templateEventRow(field, value) {
  switch (field) {
    case 'message_template_status_update':
      return { kind: 'status', from_value: null, to_value: value.event, reason: cleanReason(value.reason) }
    case 'message_template_quality_update':
      return { kind: 'quality', from_value: value.previous_quality_score ?? null, to_value: value.new_quality_score, reason: null }
    case 'template_category_update':
      return { kind: 'category', from_value: value.previous_category ?? null, to_value: value.new_category, reason: null }
    default:
      return null
  }
}
