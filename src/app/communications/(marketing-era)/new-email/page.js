// /communications/new-email — NEWEMAIL.1: start an email campaign in the full
// editor, blank or from one of the studio's marketing templates.
//
// The full editor had no "new" route: a campaign started in the quick
// composer and was handed over ("Open the full editor"), or came from a
// duplicate or an old draft. This page is the editor's own front door. It
// lists the active studio's marketing templates (listMarketingTemplates:
// confirmations, reminders and templates an event or race points at are
// never offered), and the picker creates the draft through
// POST /api/communications/campaigns, which loads the template again at the
// studio, then opens it in the editor.

import { redirect } from 'next/navigation'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { listMarketingTemplates } from '@/lib/email-templates-for-agents'
import { logError } from '@/lib/log'
import NewEmailPicker from '@/components/communications/NewEmailPicker'

export const dynamic = 'force-dynamic'

export default async function NewEmailPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const locationId = user.activeLocation?.id
  if (!locationId || assertLocationAccess(user, locationId)) redirect('/communications')
  if (!hasPermissionForLocation(user, locationId, 'email')) redirect('/communications')

  let templates = []
  let readFailed = false
  try {
    ;({ templates } = await listMarketingTemplates(createServerClient(), locationId))
  } catch (err) {
    // The blank start still works; the picker says the templates are missing.
    readFailed = true
    logError('communications', 'new email: templates unreadable', { err, locationId })
  }

  return (
    <NewEmailPicker
      locationId={locationId}
      studioName={user.activeLocation?.name || ''}
      templates={templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject, description: t.description ?? null }))}
      readFailed={readFailed}
    />
  )
}
