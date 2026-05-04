// Legacy redirect — /segments was the original Phase 2 entry, but
// segments now live as a tab inside /communications (closer to
// where operators actually use them: configuring broadcasts).
//
// Anyone with a bookmark or an old deep-link from elsewhere in the
// app lands here and hops over to the new home.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function SegmentsRedirectPage() {
  redirect('/communications/segments')
}
