import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import PresenterRemote from './PresenterRemote'

export const dynamic = 'force-dynamic'

export default async function PresentControlPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  const db = createServerClient()
  const { data: deck } = await db.from('presentations')
    .select('id, location_id, title, current_index').eq('id', params.id).maybeSingle()
  if (!deck || (!user.isMaster && !getUserLocationIds(user).includes(deck.location_id))) notFound()
  const { data: slides } = await db.from('presentation_slides')
    .select('id, position, image_path').eq('presentation_id', params.id).order('position', { ascending: true })
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides`
  return (
    <PresenterRemote
      id={deck.id}
      title={deck.title}
      initialIndex={deck.current_index || 0}
      slides={(slides || []).map((s) => ({ id: s.id, url: `${base}/${s.image_path}` }))}
    />
  )
}
