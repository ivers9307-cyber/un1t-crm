import { createServerClient } from '@/lib/supabase'
import { loadAppeal } from '@/lib/class-fees-member'
import FeeAppealForm from '@/components/FeeAppealForm'

// FEES.3 — a member's appeal against one class fee. The token is the
// credential; the page shows the fee (class, time, amount, when it is
// charged) and nothing about the member. An unknown token gets a generic
// line with no branding (no 404 that confirms a token exists).
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Class fee',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

const TEXT = {
  not_found: 'This link is not valid any more. Contact the studio if you need help with a class fee.',
  off: 'Appeals are not open at this studio right now. Contact the studio directly if you need help with this fee.',
  closed: 'This fee has already been dealt with, so it can no longer be appealed. Contact the studio if you need help.',
  appealed: 'Thanks, we have your appeal. The fee is on hold until the team has looked at it.',
}

export default async function FeeAppealPage(props) {
  const { token } = await props.params
  let view
  try {
    view = await loadAppeal(createServerClient(), token)
  } catch {
    view = { state: 'error' }
  }
  const { state, fee, branding } = view

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        {branding?.logoUrl ? (
          <img src={branding.logoUrl} alt={branding.companyName || ''} className="mx-auto mb-8 h-16 w-auto" />
        ) : null}
        {branding?.companyName ? (
          <h1 className="font-display text-2xl font-semibold mb-6 text-center">{branding.companyName}</h1>
        ) : null}
        {fee ? (
          <div className="rounded-2xl border border-white/15 p-5 mb-6 text-white/90">
            <p className="text-sm uppercase tracking-wide text-white/60">{fee.what}</p>
            <p className="text-lg font-semibold mt-1">{fee.classTitle}</p>
            <p className="text-white/80">{fee.classTime}</p>
            <p className="mt-3">Fee: <span className="font-semibold">{fee.amount}</span>{fee.chargeTime && state === 'open' ? `, charged ${fee.chargeTime}` : ''}</p>
          </div>
        ) : null}
        {state === 'open'
          ? <FeeAppealForm token={token} />
          : <p className="text-lg text-white/90 leading-relaxed text-center">{TEXT[state] || 'Something went wrong. Please try again in a minute.'}</p>}
      </div>
    </main>
  )
}
