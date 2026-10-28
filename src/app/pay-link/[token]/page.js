import { redirect, notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { resolveUn1tPayLink } from '@/lib/un1t-pay-link'
import { UN1T_PAY_PAGE_TEXT } from '@/lib/un1t-dunning-copy'

// UN1TDUN.1 — the short pay link in a un1t.online payment reminder. The
// token is the credential. An open invoice redirects to its Stripe hosted
// payment page, read live from un1t.online on every open (the URL is never
// stored, logged or rendered); a paid one shows "all paid up"; un1t.online
// unreachable shows "try again shortly" with the studio's name; an unknown
// token is a 404. Read per request, never cached.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function Un1tPayPage(props) {
  const { token } = await props.params
  let view
  try {
    view = await resolveUn1tPayLink(createServerClient(), token)
  } catch {
    view = { kind: 'unavailable', branding: null }
  }
  // Outside the try: redirect() and notFound() work by throwing.
  if (view.kind === 'not_found') notFound()
  if (view.kind === 'redirect') redirect(view.url)

  const branding = view.branding || null
  const text = view.kind === 'paid' ? UN1T_PAY_PAGE_TEXT.paid : UN1T_PAY_PAGE_TEXT.unavailable(branding?.studioName || '')

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        {branding?.logoUrl ? (
          <img src={branding.logoUrl} alt={branding.companyName || ''} className="mx-auto mb-8 h-16 w-auto" />
        ) : null}
        {branding?.companyName ? (
          <h1 className="font-display text-2xl font-semibold mb-4">{branding.companyName}</h1>
        ) : null}
        <p className="text-lg text-white/90 leading-relaxed">{text}</p>
      </div>
    </main>
  )
}
