// /class-pay/[id] — public return page for a PAID class-funnel booking. The
// Revolut returnUrl (set in Phase 1) lands here for 3DS/redirect methods; polls
// the public status route and shows booked / confirming / failed.
import { poppinsBody as poppins } from '@/fonts/poppins'
import ClassPayStatus from '@/components/ClassPayStatus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata = { robots: { index: false, follow: false } }

export default async function Page(props) {
  const { id } = await props.params
  return (
    <div className={`${poppins.variable} font-body`}>
      <ClassPayStatus paymentId={id} />
    </div>
  )
}
