// /host-connect/[token] — self-serve Stripe onboarding for an event host
// (EVENTS-HOST.5).
//
// Public, token-gated, standalone dark-branded page — the HOST's view,
// not a customer and not the CRM shell. The signed token in the path
// authenticates the host; no login. Mirrors the event-reskin shell: Poppins via
// next/font + a `font-body` wrapper, then the HostConnect client component does
// the token fetch + Stripe onboarding hand-off.

import { poppinsBody as poppins } from '@/fonts/poppins'
import { headers } from 'next/headers'
import HostConnect from '@/components/HostConnect'
import { resolveRequestHostOrgBrand } from '@/lib/host-org-brand'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function Page(props) {
  const params = await props.params
  // W1.S1c: an invalid or expired token has no host to name, so the
  // "ask <brand> for a new one" line falls back to the request host's
  // organisation (the platform name on the CRM host).
  const fallback = await resolveRequestHostOrgBrand((await headers()).get('host'))
  return (
    <div className={`${poppins.variable} font-body`}>
      <HostConnect token={params.token} fallbackBrand={fallback.name} />
    </div>
  )
}
