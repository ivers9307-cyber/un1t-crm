// XERO-ONE-ORG.1 — one location, one Xero organisation. Never shared.
//
// Every business in this estate is a separate legal entity with its own Xero
// org, so a tenant bound to two locations means one company's bills are being
// filed into another company's books. That is exactly what happened: all three
// connected locations ended up on the same tenant.
//
// The cause was `const tenant = tenants[0]` in the OAuth callback. Xero's
// /connections endpoint returns EVERY org the login has ever authorised — the
// consent screen accumulates grants — so "the first one" is whatever Xero
// happens to list first, which was the same org on all three connects. The
// operator was never shown a choice, and nothing checked whether that org was
// already spoken for. migration 029's own comment says the tenant is chosen
// "explicitly so we know which org to push into"; that was the intent, but the
// callback never implemented it.
//
// These helpers are pure so the rule is testable without OAuth: given the
// tenants a token grants and the tenants already bound elsewhere, decide what
// may be bound.

/**
 * Split the granted tenants into those free to bind and those already claimed
 * by ANOTHER location.
 *
 * @param {Array<{tenantId: string, tenantName?: string, tenantType?: string}>} tenants
 *        As returned by listConnectedTenants().
 * @param {Array<{tenant_id: string, location_id: string, location_name?: string}>} existing
 *        Every current xero_connections row.
 * @param {string} locationId  The location being connected — its OWN existing
 *        binding is not a conflict (that is a reconnect, not a steal).
 * @returns {{ free: Array, taken: Array }} `taken` entries carry `.claimedBy`.
 */
export function classifyTenants(tenants, existing, locationId) {
  const claims = new Map()
  for (const row of existing || []) {
    if (!row?.tenant_id) continue
    if (row.location_id === locationId) continue
    claims.set(row.tenant_id, row.location_name || row.location_id)
  }
  const free = []
  const taken = []
  for (const t of tenants || []) {
    if (!t?.tenantId) continue
    if (claims.has(t.tenantId)) taken.push({ ...t, claimedBy: claims.get(t.tenantId) })
    else free.push(t)
  }
  return { free, taken }
}

/**
 * Decide which tenant a fresh OAuth callback may bind.
 *
 * Deliberately never returns a tenant another location already holds — that is
 * the whole defect. When several are free it still has to pick one to store
 * (the tokens have to live somewhere before the operator can switch), so it
 * takes the first and reports `ambiguous`, which the caller surfaces as "we
 * linked X, confirm it is the right org" rather than staying silent.
 *
 * @returns {{ ok: true, tenant: object, ambiguous: boolean, alternatives: Array }
 *         | { ok: false, reason: 'none_granted'|'all_taken', taken?: Array }}
 */
export function chooseTenantToBind(tenants, existing, locationId) {
  if (!tenants || !tenants.length) return { ok: false, reason: 'none_granted' }
  const { free, taken } = classifyTenants(tenants, existing, locationId)
  if (!free.length) return { ok: false, reason: 'all_taken', taken }

  // XERO-ONE-ORG.4 — a RECONNECT keeps the org it is already on.
  //
  // Without this the function returns free[0], and "free" includes the
  // location's own current binding alongside any org nobody holds — so the
  // winner is whatever Xero happens to list first. That is the original
  // tenants[0] defect wearing a different hat, and it became live the moment
  // CCF Autos was disconnected: its org went back into the free pool, so a
  // routine Stillorgan reconnect could have silently moved it off Champ
  // Fitness and started filing a gym's bills into a consultancy again.
  // Reconnecting is what an operator does when a token expires; it must never
  // change which company gets billed.
  const current = (existing || []).find((r) => r?.location_id === locationId)?.tenant_id
  const keep = current ? free.find((t) => t.tenantId === current) : null
  if (keep) return { ok: true, tenant: keep, ambiguous: false, alternatives: [] }

  return {
    ok: true,
    tenant: free[0],
    ambiguous: free.length > 1,
    alternatives: free.slice(1),
  }
}

/**
 * Guard for an explicit switch (the operator picking an org on the settings
 * card). Unlike the callback this never falls back — a wrong answer here would
 * re-file a company's bills into another company's books.
 *
 * @returns {{ ok: true, tenant: object } | { ok: false, error: string }}
 */
export function validateTenantChoice(tenantId, tenants, existing, locationId) {
  if (!tenantId) return { ok: false, error: 'No organisation chosen.' }
  const tenant = (tenants || []).find((t) => t?.tenantId === tenantId)
  if (!tenant) {
    return { ok: false, error: 'That organisation is not one this Xero login has authorised. Reconnect and grant access to it first.' }
  }
  const { taken } = classifyTenants(tenants, existing, locationId)
  const clash = taken.find((t) => t.tenantId === tenantId)
  if (clash) {
    return {
      ok: false,
      error: `"${tenant.tenantName || tenantId}" is already connected to ${clash.claimedBy}. Each location must use its own Xero organisation — disconnect it there first.`,
    }
  }
  return { ok: true, tenant }
}
