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
//
// QUICKEMAIL-RETIRE.1 — the Segments page's "Email" links land here:
// ?segment=<tag> seeds one tag clause, ?segment_id=<uuid> a saved segment's
// filter. The saved segment is read AT the active studio (a foreign id finds
// nothing) and only for someone who may read segments there.

import { redirect } from 'next/navigation'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { listMarketingTemplates } from '@/lib/email-templates-for-agents'
import { logError } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { canReadSegmentsAt } from '@/lib/segment-access'
import NewEmailPicker from '@/components/communications/NewEmailPicker'

export const dynamic = 'force-dynamic'

export default async function NewEmailPage(props) {
  const searchParams = (await props?.searchParams) || {}
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const locationId = user.activeLocation?.id
  if (!locationId || assertLocationAccess(user, locationId)) redirect('/communications')
  if (!hasPermissionForLocation(user, locationId, 'email')) redirect('/communications')

  const db = createServerClient()
  const audience = await startingAudience(db, user, locationId, searchParams)

  let templates = []
  let readFailed = false
  try {
    ;({ templates } = await listMarketingTemplates(db, locationId))
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
      audience={audience}
    />
  )
}

// The audience a Segments link asked for, or null. A segment that cannot be
// read (another studio's, gone, no permission, a failed read) is not applied
// and the page says so, rather than starting an email to the wrong people.
async function startingAudience(db, user, locationId, searchParams) {
  const tag = typeof searchParams.segment === 'string' ? searchParams.segment.trim() : ''
  if (tag) {
    return { label: `Tag: ${tag}`, filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: tag }] } }
  }
  const id = typeof searchParams.segment_id === 'string' ? searchParams.segment_id : ''
  if (!id) return null
  if (!uuidLike.safeParse(id).success || !canReadSegmentsAt(user, locationId)) return { missing: true }
  const { data, error } = await db
    .from('contact_segments')
    .select('id, name, filter')
    .eq('id', id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) {
    logError('communications', 'new email: segment unreadable', { err: error, locationId })
    return { missing: true }
  }
  if (!data?.filter) return { missing: true }
  return { label: data.name, filter: data.filter }
}
