import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser, guardMasterOrOwner } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { createServerClient } from '@/lib/supabase'
import { renderInputsFor } from '@/lib/pipeline-board-followups'
import { RECIPES } from '@shared/pipelines/recipes.js'
import BoardWizard from '@/components/pipelines/BoardWizard'

export const dynamic = 'force-dynamic'

// PIPEBUILD.5i — /settings/pipelines/new: the board wizard. Owners, org admins
// and masters at the active studio build boards (guardMasterOrOwner, the
// create route's gate); anyone else on the pipelines page sees a notice. The
// studio's membership source rides on the user object (CLIENT_LOCATION_COLUMNS).
export default async function NewBoardPage(props) {
  const sp = (await props.searchParams) || {}
  const wanted = Array.isArray(sp.recipe) ? sp.recipe[0] : sp.recipe
  const initialRecipe = typeof wanted === 'string' && Object.hasOwn(RECIPES, wanted) ? wanted : undefined
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const location = user.activeLocation
  if (!location?.id) redirect('/settings')
  const canEdit = guardMasterOrOwner(user, location.id) === null

  // The Book and app buttons the follow-ups will carry, so the preview shows
  // what Meta gets. renderInputsFor returns only those keys, never settings;
  // a failed read previews without buttons (the server decides at install).
  let bookingFlowId
  let appLinks
  if (canEdit) {
    const inputs = await renderInputsFor(createServerClient(), { name: '', config: {} }, location.id)
    if (inputs.ok) {
      bookingFlowId = inputs.render.bookingFlowId
      appLinks = inputs.render.appLinks
    }
  }

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/settings/pipelines" className="text-sm text-un1t-accent">Pipelines</Link>
      <h1 className="text-2xl font-bold mt-1 mb-6">New board</h1>
      <BoardWizard
        locationId={location.id}
        studioName={location.name || ''}
        canEdit={canEdit}
        membershipSource={location.membership_source ?? null}
        bookingFlowId={bookingFlowId}
        appLinks={appLinks}
        initialRecipe={initialRecipe}
      />
    </div>
  )
}
