// /host-connect/[token] — self-serve Stripe onboarding for an event host
// (EVENTS-HOST.5).
//
// Public, token-gated, standalone dark UN1T-branded page — the HOST's view,
// not a customer and not the CRM shell. The signed token in the path
// authenticates the host; no login. Mirrors the event-reskin shell: Poppins via
// next/font + a `font-body` wrapper, then the HostConnect client component does
// the token fetch + Stripe onboarding hand-off.

import { poppinsBody as poppins } from '@/fonts/poppins'
import HostConnect from '@/components/HostConnect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function Page(props) {
  const params = await props.params
  return (
    <div className={`${poppins.variable} font-body`}>
      <HostConnect token={params.token} />
    </div>
  )
}
