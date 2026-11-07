import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { createServerClient } from '@/lib/supabase'
import { boardLocationId } from '@/lib/pipeline-boards'
import { renderInputsFor } from '@/lib/pipeline-board-followups'
import BoardSettings from '@/components/pipelines/BoardSettings'

export const dynamic = 'force-dynamic'

// PIPEBUILD.5k — /settings/pipelines/[id]: one board's settings. The board
// itself, and who may do what with it, come from GET /api/pipelines/[id] in
// the component (the route is the gate). Here: the board's studio, so a board
// at a studio the person does not belong to is a 404 like a missing one, and
// the fill-ins the follow-up preview needs. renderInputsFor returns only the
// studio name and the Book / app buttons, never `settings`; a failed read
// previews without buttons (the server decides at install).
export default async function BoardSettingsPage({ params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const { id } = await params
  if (!uuidLike.safeParse(id).success) notFound()

  const db = createServerClient()
  const where = await boardLocationId(db, id)
  if (!where.ok && where.status === 404) notFound()
  const locationId = where.ok ? where.locationId : user.activeLocation?.id
  if (!locationId) redirect('/settings')
  if (assertLocationAccessOr404(user, locationId)) notFound()

  let studioName = ''
  let bookingFlowId
  let appLinks
  const inputs = await renderInputsFor(db, { name: '', config: {} }, locationId)
  if (inputs.ok) {
    studioName = inputs.render.studioName || ''
    bookingFlowId = inputs.render.bookingFlowId
    appLinks = inputs.render.appLinks
  }

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/settings/pipelines" className="text-sm text-un1t-accent">Pipelines</Link>
      <h1 className="text-2xl font-bold mt-1 mb-6">Board settings</h1>
      <BoardSettings
        boardId={id}
        locationId={locationId}
        studioName={studioName}
        bookingFlowId={bookingFlowId}
        appLinks={appLinks}
      />
    </div>
  )
}
