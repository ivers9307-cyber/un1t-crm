// /host/set-password (HOST-PORTAL.1) — server shell for the host invite /
// set-password page.
//
// W1.S1c: pre-auth, so the request's hostname is the only input (see
// /host/login/page.js); the CRM host reads the platform name. The client
// body, with the shared recovery-link handshake, is HostSetPasswordForm.

import { headers, cookies } from 'next/headers'
import { resolveRequestHostOrgBrand } from '@/lib/host-org-brand'
import HostSetPasswordForm from './HostSetPasswordForm'
import HostThemeToggle from '@/components/host/HostThemeToggle'
import { HOST_THEME_COOKIE, hostThemeFromCookie } from '@/lib/host-theme'

export default async function HostSetPasswordPage() {
  const brand = await resolveRequestHostOrgBrand((await headers()).get('host'))
  // HOSTTHEME.1: a string only, never a function, to the client toggle.
  const theme = hostThemeFromCookie((await cookies()).get(HOST_THEME_COOKIE)?.value)
  return (
    <>
      <div className="fixed right-4 top-4 z-10">
        <HostThemeToggle initial={theme} />
      </div>
      <HostSetPasswordForm brand={{ name: brand.name, shortName: brand.shortName }} />
    </>
  )
}
