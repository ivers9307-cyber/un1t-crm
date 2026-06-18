import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import PresentationEditor from './PresentationEditor'

export const dynamic = 'force-dynamic'

export default async function PresentationEditPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  const db = createServerClient()
  const { data: deck } = await db.from('presentations')
    .select('id, location_id, title, view_token').eq('id', params.id).maybeSingle()
  if (!deck || (!user.isMaster && !getUserLocationIds(user).includes(deck.location_id))) notFound()
  return <PresentationEditor id={deck.id} title={deck.title} viewToken={deck.view_token} appUrl={process.env.NEXT_PUBLIC_APP_URL} />
}
