import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import WATemplateEditor from '@/components/WATemplateEditor'

export const dynamic = 'force-dynamic'

export default async function NewWATemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <WATemplateEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
