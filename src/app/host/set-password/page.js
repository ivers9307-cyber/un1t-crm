// /host/set-password (HOST-PORTAL.1) — server shell for the host invite /
// set-password page.
//
// W1.S1c: pre-auth, so the request's hostname is the only input (see
// /host/login/page.js); the CRM host reads the platform name. The client
// body, with the shared recovery-link handshake, is HostSetPasswordForm.

import { headers } from 'next/headers'
import { resolveRequestHostOrgBrand } from '@/lib/host-org-brand'
import HostSetPasswordForm from './HostSetPasswordForm'

export default async function HostSetPasswordPage() {
  const brand = await resolveRequestHostOrgBrand((await headers()).get('host'))
  return <HostSetPasswordForm brand={{ name: brand.name, shortName: brand.shortName }} />
}
