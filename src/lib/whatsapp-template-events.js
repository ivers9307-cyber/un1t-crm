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

// IO: apply one template webhook event to the DB. Matches by meta_template_id,
// idempotent (skip-when-unchanged → Meta retries are no-ops, no double-notify),
// updates the row, writes the audit row, and returns the notification decision.
// Best-effort caller (the webhook route) swallows errors.
export async function applyTemplateEvent(db, field, value) {
  const update = templateColumnUpdate(field, value)
  if (!update) return { skipped: 'unknown_field' }

  const metaId = String(value.message_template_id)
  // K8 — `.maybeSingle()`, not `.single()`: `no_match` below is a DESIGNED
  // outcome (Meta sends events for templates created outside this CRM), so 0
  // rows must resolve to null rather than to an error we discard. With
  // `.single()` a genuinely failed query was indistinguishable from a real
  // no-match and got reported as one; `meta_template_id` carries no unique
  // index either, so the >1-row case is reachable in principle. Both now
  // surface as `lookup_failed`, which the caller treats as "do nothing" the
  // same way but which is honest in the logs.
  const { data: template, error: templateErr } = await db.from('whatsapp_templates')
    .select('id, location_id, name, status, quality_rating, category, rejection_reason')
    .eq('meta_template_id', metaId)
    .maybeSingle()
  if (templateErr) {
    console.error('[wa-template-events] template lookup failed:', templateErr.message)
    return { skipped: 'lookup_failed' }
  }
  if (!template) return { skipped: 'no_match' }

  // Idempotent: if every target column already equals the new value, no-op.
  const changed = Object.entries(update).some(([k, v]) => template[k] !== v)
  if (!changed) return { skipped: 'unchanged', template }

  await db.from('whatsapp_templates').update(update).eq('id', template.id)

  const ev = templateEventRow(field, value)
  if (ev) {
    await db.from('whatsapp_template_events').insert({
      template_id: template.id,
      location_id: template.location_id,
      ...ev,
    })
  }

  return { template, notify: templateNotification(field, value, template.name) }
}
