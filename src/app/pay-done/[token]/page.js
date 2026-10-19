import { createServerClient } from '@/lib/supabase'
import { payDonePage } from '@/lib/agent/pay-done'

// MIAHATCH.6 (Task 22) — where un1t.online's hosted checkout returns a member
// after paying for a link Mia sent (success), or ?c=1 (cancelled).
//
// A CHECK TRIGGER, never proof of payment: payDonePage may ask the settle to
// look, and the text below is the same whatever it finds. Nothing about the
// member, the product, the price or any URL is rendered; an unknown token gets
// the generic default copy with no branding (no 404 that confirms a token).
// Read per request, never cached (the token and the intent state are per visit).
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function PayDonePage(props) {
  const { token } = await props.params
  const searchParams = await props.searchParams
  const { text, branding } = await payDonePage(createServerClient(), token, { cancelled: searchParams?.c === '1' })

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
