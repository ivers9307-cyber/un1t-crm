import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// Redirect to /communications/inbox, preserving any ?c=<id> query.
export default async function InboxRedirect(props) {
  const searchParams = await props.searchParams;
  const c = searchParams?.c
  redirect(c ? `/communications/inbox?c=${encodeURIComponent(c)}` : '/communications/inbox')
}
