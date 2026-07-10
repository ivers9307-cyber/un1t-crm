// Event-host (payee) operator helpers (EVENTS-HOST.2). Non-auth utilities
// shared across the /api/hosts routes. The auth gate stays INLINE in each
// route (each must literally call getCurrentUser() for check:route-guards).

export const HOST_COLS =
  'id, name, email, payment_provider, stripe_connected_account_id, ' +
  'charges_enabled, payouts_enabled, details_submitted, ' +
  'onboarding_completed_at, requirements_currently_due, platform_fee_cents, ' +
  'organization_id, created_at, ' +
  // Sender identity (HOST-EMAIL.2, mig 400) — the HostDetail "Email sending"
  // card + /api/hosts/[id]/email-domain routes read these off loadHostForOrg.
  'sender_domain, sender_email, sender_name, sender_domain_verified, ' +
  'postmark_domain_id, email_daily_send_cap, slug'

/**
 * Load a host scoped to the caller's org. Returns null when the id is unknown
 * OR belongs to another org — callers 404 either way (no IDOR enumeration).
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {string} id
 * @param {string} orgId
 * @returns {Promise<object|null>}
 */
export async function loadHostForOrg(db, id, orgId) {
  const { data } = await db.from('event_hosts').select(HOST_COLS).eq('id', id).maybeSingle()
  if (!data || data.organization_id !== orgId) return null
  return data
}
