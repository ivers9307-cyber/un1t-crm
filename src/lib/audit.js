// AUDIT-EXPAND.1 — generic audit-log writer.
//
// Mirrors the fire-and-forget shape of logAssignmentChange (mig 080):
// returns { logged: bool, error?: string }, never throws, failure is
// console-logged but does NOT block the surrounding mutation. The
// audit trail is best-effort — losing one row is preferable to
// losing the actual mutation when the audit table is briefly
// unavailable (network blip, RLS misconfig, etc.).
//
// Callers should pass:
//   - category    'auth' | 'business' | 'mutation' | 'assignment'
//   - action      '<domain>.<verb>' — e.g. 'contract.issued',
//                  'auth.sign_in', 'policy.published'
//   - actor       { id, full_name?, email? } — the user doing it.
//                  Optional — auth.sign_in failure with unknown
//                  email has no actor.
//   - target      { id?, label?, resource? } — the user / resource
//                  the action is about. resource is a stable
//                  '<type>/<id>' string.
//   - locationId  optional location scope
//   - details     JSONB payload — action-specific shape.
//   - request     optional Request object — we pull IP + UA off it.
//
// The helper is happy with partial input — only category + action
// are strictly required. Missing actor / target are common (an
// inbound sign-in has no actor until it succeeds).

import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

function parseClientIp(request) {
  if (!request) return null
  try {
    const xff = request.headers.get('x-forwarded-for') || ''
    const ip = xff.split(',')[0]?.trim()
    return ip || null
  } catch { return null }
}

function parseUserAgent(request) {
  if (!request) return null
  try { return request.headers.get('user-agent') || null }
  catch { return null }
}

/**
 * Insert an audit_events row. See header comment for arg shape.
 *
 * @param {object} args
 * @param {'auth'|'business'|'mutation'|'assignment'} args.category
 * @param {string} args.action
 * @param {{ id?: string, full_name?: string, email?: string } | null} [args.actor]
 * @param {{ id?: string, label?: string, resource?: string } | null} [args.target]
 * @param {string | null} [args.locationId]
 * @param {object | null} [args.details]
 * @param {Request | null} [args.request]
 * @returns {Promise<{ logged: boolean, error?: string }>}
 */
export async function logAuditEvent({
  category,
  action,
  actor = null,
  target = null,
  locationId = null,
  details = null,
  request = null,
} = {}) {
  if (!category || !action) {
    return { logged: false, error: 'missing_category_or_action' }
  }
  const actorLabel = actor
    ? (actor.full_name && actor.email
        ? `${actor.full_name} <${actor.email}>`
        : (actor.full_name || actor.email || null))
    : null
  const targetLabel = target?.label || null

  try {
    const db = createServerClient()
    const { error } = await db.from('audit_events').insert({
      category,
      action,
      actor_id: actor?.id || null,
      actor_label: actorLabel,
      target_profile_id: target?.id || null,
      target_label: targetLabel,
      target_resource: target?.resource || null,
      location_id: locationId,
      details: details || null,
      ip_address: parseClientIp(request),
      user_agent: parseUserAgent(request),
    })
    if (error) {
      logWarn('audit', 'insert failed', { category, action, err: error.message })
      return { logged: false, error: error.message }
    }
    return { logged: true }
  } catch (e) {
    logWarn('audit', 'threw', { category, action, err: e?.message })
    return { logged: false, error: e?.message || 'unknown' }
  }
}
