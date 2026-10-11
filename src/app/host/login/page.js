// /host/login (HOST-PORTAL.1) — server shell for the host-portal login.
//
// W1.S1c: pre-auth, so the request's hostname is the only input. The host
// maps to an organisation through W1.L4's resolver (host.un1tdublin.com and
// <slug>.repset.ie are UN1T Group's / the tenant's), and that organisation's
// brand is the wordmark and the "access is set up by" line. The CRM host has
// no organisation and reads the platform name. The client body is
// HostLoginForm.

import { headers } from 'next/headers'
import { resolveRequestHostOrgBrand } from '@/lib/host-org-brand'
import HostLoginForm from './HostLoginForm'

export default async function HostLoginPage() {
  const brand = await resolveRequestHostOrgBrand((await headers()).get('host'))
  return <HostLoginForm brand={{ name: brand.name, shortName: brand.shortName }} />
}
