// STUDIO-PIN.3 — /studio-login
//
// The PIN entry landing for paired studio devices. Mac shell + iPad
// both default to this URL on launch (and on idle-lock). The page
// itself is a thin wrapper around StudioLogin.jsx — no server-side
// auth gate here on purpose: the whole point is to let an
// unauthenticated device prove identity via PIN.

import StudioLogin from '@/components/StudioLogin'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'CF Studio — Sign in',
}

export default function StudioLoginPage() {
  return <StudioLogin />
}
