import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// Redirect to /communications/inbox, preserving any ?c=<id> query.
export default function InboxRedirect({ searchParams }) {
  const c = searchParams?.c
  redirect(c ? `/communications/inbox?c=${encodeURIComponent(c)}` : '/communications/inbox')
}
