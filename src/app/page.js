// Root — redirects to /dashboard. The actual landing logic
// (Business → Studio → Today fallback based on permissions) lives
// in /dashboard/page.js.
//
// We keep this as a separate redirect so existing bookmarks /
// hard-coded `/` links continue to work.

import { redirect } from 'next/navigation'

export default function Root() {
  redirect('/dashboard')
}
