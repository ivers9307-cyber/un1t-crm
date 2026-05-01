import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function EmailTemplatesRedirect() {
  redirect('/communications/templates?channel=email')
}
