// PAGES.1 — which organisation owns the landing pages served on a public host.
// Edge-safe on purpose: the proxy (Next middleware, edge runtime) imports it,
// so it may import only edge-safe modules (brands, tenant-domains-edge). Task 5
// adds the live slug list the proxy rewrites on. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md.

import { resolveBrand, UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { resolveTenantOrgId } from '@/lib/tenant-domains-edge'

/**
 * Host → organisation id. An in-code brand that carries an `organizationId`
 * (un1tdublin.com) wins; else a `tenant_domains` row; else UN1T Group, which is
 * also the answer for the CRM host and for a missing hostname.
 */
export async function publicOrgIdForHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return UN1T_GROUP_ORG_ID
  const brand = resolveBrand(hostname)
  if (brand?.organizationId) return brand.organizationId
  const tenantOrgId = await resolveTenantOrgId(hostname)
  return tenantOrgId || UN1T_GROUP_ORG_ID
}
