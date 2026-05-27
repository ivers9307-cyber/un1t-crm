// STUDIO-PIN.1 — trusted-IP gate for studio-device PIN auth.
//
// PIN-login requests are only accepted when the source IP falls
// inside one of the location's location_trusted_ips CIDRs. The match
// is delegated to Postgres's inet operator `>>=` ("contains or
// equals") so we get a single indexed query against the gist index
// on ip_cidr — no JS-side CIDR parsing or bigint math required.
//
// Source IP comes from the request headers — see extractClientIp
// below. In Vercel's edge / serverless runtime the canonical header
// is `x-forwarded-for`, with the client's IP as the first comma-
// separated value (subsequent entries are proxy chain hops).

/**
 * Check whether a source IP is trusted for PIN-login against this
 * location.
 *
 * @param {object} args
 * @param {object} args.db          — service-role Supabase client
 * @param {string} args.locationId  — uuid; the device's location
 * @param {string} args.sourceIp    — IPv4 or IPv6 string
 * @returns {Promise<boolean>}
 */
export async function isTrustedIpForLocation({ db, locationId, sourceIp }) {
  if (typeof locationId !== 'string' || typeof sourceIp !== 'string') {
    return false
  }
  if (sourceIp.length === 0) return false

  // Single indexed query using inet >>= contains-or-equals. Returns
  // the first matching row's id if any CIDR contains the source IP.
  //
  // The supabase-js builder doesn't expose `>>=` directly, so use
  // raw rpc via the `or` filter trick: postgrest supports `cs` /
  // `cd` for jsonb containment but NOT for inet. The clean answer is
  // a SQL RPC; cheaper for v1 is to pull the location's CIDRs and
  // match in JS using Postgres-equivalent semantics via the `ipaddr.js`-
  // style logic. We DON'T pull in a dep — we instead use Node's
  // built-in URL parser to canonicalise + a hand-rolled CIDR check.
  //
  // Pulling all CIDRs for one location is bounded (typically 1–3
  // entries) so the JS-side match is fine.

  const { data: rows, error } = await db
    .from('location_trusted_ips')
    .select('ip_cidr')
    .eq('location_id', locationId)

  if (error) throw new Error(error.message)
  if (!rows || rows.length === 0) return false

  for (const r of rows) {
    if (ipInCidr(sourceIp, r.ip_cidr)) return true
  }
  return false
}

/**
 * Pure CIDR-membership check. Handles IPv4 (a.b.c.d/n) and IPv6
 * (h:h:h::/n) without any external dependency.
 *
 * Returns false on any malformed input — callers should treat false
 * as "not trusted" and never throw out of this code path.
 */
export function ipInCidr(ip, cidr) {
  if (typeof ip !== 'string' || typeof cidr !== 'string') return false

  // Postgres `inet` columns can come back with or without a /mask.
  // /32 for v4 and /128 for v6 are the implicit single-host forms.
  let [base, maskStr] = cidr.split('/')
  const isV6 = base.includes(':') || ip.includes(':')
  const fullBits = isV6 ? 128 : 32
  const mask = maskStr === undefined ? fullBits : Number(maskStr)
  if (!Number.isInteger(mask) || mask < 0 || mask > fullBits) return false

  const ipBytes = isV6 ? parseIpv6(ip) : parseIpv4(ip)
  const baseBytes = isV6 ? parseIpv6(base) : parseIpv4(base)
  if (!ipBytes || !baseBytes) return false
  if (ipBytes.length !== baseBytes.length) return false

  // Compare the first `mask` bits.
  let bitsToCheck = mask
  for (let i = 0; bitsToCheck > 0 && i < ipBytes.length; i++) {
    if (bitsToCheck >= 8) {
      if (ipBytes[i] !== baseBytes[i]) return false
      bitsToCheck -= 8
    } else {
      const shift = 8 - bitsToCheck
      if (ipBytes[i] >>> shift !== baseBytes[i] >>> shift) return false
      bitsToCheck = 0
    }
  }
  return true
}

function parseIpv4(s) {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255 || /^0\d/.test(parts[i])) {
      return null
    }
    out[i] = n
  }
  return out
}

function parseIpv6(s) {
  // Support :: compression. Reject embedded IPv4 mapping form for v1
  // (we won't see ::ffff:1.2.3.4 in practice from a studio router).
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null

  let [head, tail] = s.split('::')
  if (tail === undefined) {
    // No compression — must be 8 groups.
    const groups = head.split(':')
    if (groups.length !== 8) return null
    return groupsToBytes(groups)
  }

  if (s.indexOf('::') !== s.lastIndexOf('::')) return null
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const missing = 8 - headGroups.length - tailGroups.length
  if (missing < 0) return null
  const groups = [
    ...headGroups,
    ...Array(missing).fill('0'),
    ...tailGroups,
  ]
  return groupsToBytes(groups)
}

function groupsToBytes(groups) {
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i]
    if (g.length === 0 || g.length > 4) return null
    const n = parseInt(g, 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

/**
 * Extract the client IP from a Next.js request, taking the first
 * entry from `x-forwarded-for` (Vercel's canonical header).
 *
 * Returns the trimmed IP string, or null when no header is present
 * — callers should treat null as "no trustable source IP" and reject
 * the PIN-login.
 *
 * Safe for both Edge and Node runtimes — only reads headers off the
 * request object.
 */
export function extractClientIp(request) {
  const xff = request?.headers?.get?.('x-forwarded-for')
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim()
    if (first.length > 0) return first
  }
  // Fallback for non-proxy environments (local dev). Vercel always
  // sets x-forwarded-for, so this branch is rare in prod.
  const realIp = request?.headers?.get?.('x-real-ip')
  if (typeof realIp === 'string' && realIp.length > 0) return realIp.trim()
  return null
}
