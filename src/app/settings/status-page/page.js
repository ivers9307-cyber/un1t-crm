// /settings/status-page — operator editor for the public member status page
// copy (STATUS-PAGE.2). settings-permission gated; the client form reads/writes
// /api/settings/status-page (locations.settings.status_page). Blank fields fall
// back to the shipped defaults, so an operator only fills in what they want to
// change.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import StatusPageSettingsForm from '@/components/settings/StatusPageSettingsForm'

export const dynamic = 'force-dynamic'

export default async function StatusPageSettings() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Public status page</h1>
      <p className="text-sm text-un1t-subtle mb-6">
        The wording members see on your public status page. Leave a field blank to use the default shown as its placeholder. Members only ever see a plain-language status — never internal detail.
      </p>
      <StatusPageSettingsForm />
    </div>
  )
}
