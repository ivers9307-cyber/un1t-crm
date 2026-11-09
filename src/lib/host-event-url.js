// HOSTPORTAL.4 — the public URL of one of a host's events: the origin of the
// host's ANCHOR studio's tenant host + /event/<slug>. Origin only, so a
// misconfigured env var's path or query can't poison the link. The Promote
// page, the QR route and the announce-draft route all build it through here.

import { resolveCustomerBaseUrl } from '@/lib/tenant-host'

/**
 * @returns {Promise<string>} e.g. https://studio.example/event/summer-run
 * @throws when the slug is empty, the host row is unreadable or the base cannot be resolved
 */
export async function hostEventPublicUrl(db, hostId, slug) {
  if (!slug) throw new Error('event has no slug')
  const { data: hostRow, error } = await db
    .from('event_hosts')
    .select('anchor_location_id')
    .eq('id', hostId)
    .maybeSingle()
  if (error) throw error
  const baseUrl = new URL(await resolveCustomerBaseUrl(db, hostRow?.anchor_location_id || null)).origin
  return `${baseUrl}/event/${slug}`
}
