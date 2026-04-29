import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import TemplateEditor from '@/components/TemplateEditor'

export const dynamic = 'force-dynamic'

export default async function NewTemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <TemplateEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
