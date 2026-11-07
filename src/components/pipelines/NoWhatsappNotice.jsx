import Link from 'next/link'

// RAILS.5 — one copy of the "no WhatsApp number" notice, shared by the
// Pipelines list, the wizard and the board settings.
export const NO_WHATSAPP_NOTICE = 'This studio has no WhatsApp number switched on. The board can be built and saved, but its follow-ups cannot be submitted until a number is on.'
export const NO_WHATSAPP_LINK_TEXT = 'Switch one on in Integrations'
export const NO_WHATSAPP_LINK_HREF = '/settings/integrations-hub?manage=whatsapp-numbers'

export default function NoWhatsappNotice({ className = 'text-sm text-amber-700' }) {
  return (
    <p className={className} role="status">
      {NO_WHATSAPP_NOTICE}{' '}
      <Link href={NO_WHATSAPP_LINK_HREF} className="text-un1t-accent">{NO_WHATSAPP_LINK_TEXT}</Link>
    </p>
  )
}
