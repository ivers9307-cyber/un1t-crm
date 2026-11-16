import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { loadBuyPage, buyPageCopy, fillFirstName as fill } from '@/lib/staff-payment-link-checkout'
import { TRIAL_CARD, TRIAL_MUTED, TRIAL_SUMMARY } from '@/components/landing-page/trial-card'
import BuyForm from './BuyForm'

// PAYLINK.1 — the page behind a staff-sent payment link (/buy/<token>). The
// token is the credential. A new customer sees the product, the current price,
// their name and email, and un1t.online's terms tick; an existing member the
// same page without the tick. "Continue to payment" POSTs to
// /api/public/buy/<token>, which sends them to un1t.online's own hosted
// checkout; un1t.online brings them back here with ?paid=1 or ?cancelled=1.
//
// Opening the page never calls un1t.online and never makes a checkout (a GET
// from a link-preview crawler included); the only write is the first-open
// stamp. ?paid=1 says only that the customer came back from paying: until the
// mirror shows the payment the page says it is being confirmed, never "not
// paid", and offers no second checkout. Read per request, never cached.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

function AppLinks({ appLinks }) {
  if (!appLinks?.iosUrl && !appLinks?.androidUrl) return null
  return (
    <div className="mt-6">
      {appLinks.heading ? <p className="font-semibold">{appLinks.heading}</p> : null}
      {appLinks.body ? <p className={`mt-1 text-sm ${TRIAL_MUTED}`}>{appLinks.body}</p> : null}
      <div className="mt-3 flex flex-col gap-2">
        {appLinks.iosUrl ? <a href={appLinks.iosUrl} className="rounded-full bg-black text-white py-3 px-6 text-center font-bold text-sm">Download on the App Store</a> : null}
        {appLinks.androidUrl ? <a href={appLinks.androidUrl} className="rounded-full bg-black text-white py-3 px-6 text-center font-bold text-sm">Get it on Google Play</a> : null}
      </div>
    </div>
  )
}

function Shell({ branding, children }) {
  return (
    <main className="min-h-screen bg-white text-black flex items-center justify-center px-6 py-16">
      <div className={TRIAL_CARD}>
        {branding?.logoUrl ? (
          <img src={branding.logoUrl} alt={branding.companyName || ''} className="mx-auto mb-6 h-14 w-auto" />
        ) : null}
        {branding?.companyName ? (
          <p className="text-center font-display text-xl font-semibold mb-4">{branding.companyName}</p>
        ) : null}
        {children}
      </div>
    </main>
  )
}

export default async function BuyPage(props) {
  const { token } = await props.params
  const sp = (await props.searchParams) || {}
  let view
  try {
    view = await loadBuyPage(createServerClient(), token)
  } catch {
    view = { kind: 'unavailable', branding: null }
  }
  // Outside the try: notFound() works by throwing.
  if (view.kind === 'not_found') notFound()

  const copy = view.copy || buyPageCopy(null)
  const branding = view.branding || null
  const firstName = view.person?.first_name || ''

  // Back from un1t.online's checkout. Never a "not paid" message and never a
  // new checkout from here: the payment may not have reached the mirror yet.
  // Only for a link still payable or paid: an expired, revoked or
  // product-gone link shows its own state.
  if (sp.paid === '1' && (view.kind === 'ready' || view.kind === 'paid')) {
    const seen = view.kind === 'paid'
    return (
      <Shell branding={branding}>
        <h1 className="text-center text-2xl font-bold">{seen ? fill(copy.paid_heading, firstName) : fill(copy.confirming_text, firstName)}</h1>
        {view.createdAccount ? <p className={`mt-4 text-center ${TRIAL_MUTED}`}>{copy.set_password_text}</p> : null}
        <AppLinks appLinks={view.appLinks} />
      </Shell>
    )
  }

  if (view.kind !== 'ready') {
    const text = view.kind === 'paid' ? copy.paid_text : view.kind === 'expired' ? copy.expired_text : copy.unavailable_text
    return (
      <Shell branding={branding}>
        <p className="text-center text-lg leading-relaxed">{text}</p>
      </Shell>
    )
  }

  return (
    <Shell branding={branding}>
      <h1 className="text-center text-2xl font-bold mb-5">{view.isNew ? copy.page_title_new : copy.page_title_existing}</h1>
      <div className={TRIAL_SUMMARY}>
        <p className="font-semibold">{view.product.title}</p>
        {view.product.price_label ? <p className="text-lg font-bold">{view.product.price_label}</p> : null}
      </div>
      <div className="mb-5 text-sm">
        {view.person.first_name ? <p className="font-semibold">{view.person.first_name}</p> : null}
        {view.person.email ? <p className={TRIAL_MUTED}>{view.person.email}</p> : null}
        <p className={`mt-1 ${TRIAL_MUTED}`}>{copy.not_you_text}</p>
      </div>
      <BuyForm
        token={token}
        isNew={view.isNew}
        terms={view.terms}
        buttonText={copy.continue_button}
        messages={{
          paid: copy.paid_text, expired: copy.expired_text, unavailable: copy.unavailable_text, help: copy.help_text,
          confirming: `${fill(copy.confirming_text, view.person.first_name)} ${copy.retry_later_text}`,
        }}
      />
    </Shell>
  )
}
