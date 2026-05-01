import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function WhatsappTemplatesRedirect() {
  redirect('/communications/templates?channel=whatsapp')
}
