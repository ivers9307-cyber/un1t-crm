// /communications/instagram — retired in UIX-P1b. Instagram DMs live
// in the unified inbox at /communications/inbox; this stub preserves
// old deep links (?c=<id> → ?c=<id>&ch=ig).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function InstagramInboxRedirect(props) {
  const searchParams = await props.searchParams
  const c = searchParams?.c
  redirect(c ? `/communications/inbox?c=${encodeURIComponent(c)}&ch=ig` : '/communications/inbox')
}
