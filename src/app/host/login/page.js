// /host/login (HOST-PORTAL.1) — server shell for the host-portal login.
//
// W1.S1c: pre-auth, so the request's hostname is the only input. The host
// maps to an organisation through W1.L4's resolver (host.un1tdublin.com and
// <slug>.repset.ie are UN1T Group's / the tenant's), and that organisation's
// brand is the wordmark and the "access is set up by" line. The CRM host has
// no organisation and reads the platform name. The client body is
// HostLoginForm.

import { headers, cookies } from 'next/headers'
import { resolveRequestHostOrgBrand } from '@/lib/host-org-brand'
import HostLoginForm from './HostLoginForm'
import HostThemeToggle from '@/components/host/HostThemeToggle'
import { HOST_THEME_COOKIE, hostThemeFromCookie } from '@/lib/host-theme'

export default async function HostLoginPage() {
  const brand = await resolveRequestHostOrgBrand((await headers()).get('host'))
  // HOSTTHEME.1: a string only, never a function, to the client toggle.
  const theme = hostThemeFromCookie((await cookies()).get(HOST_THEME_COOKIE)?.value)
  return (
    <>
      <div className="fixed right-4 top-4 z-10">
        <HostThemeToggle initial={theme} />
      </div>
      <HostLoginForm brand={{ name: brand.name, shortName: brand.shortName }} />
    </>
  )
}
