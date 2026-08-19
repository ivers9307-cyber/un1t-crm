'use client'

// STAFF-WEB-LOCK — escape hatch on the wall page. A walled user is signed
// in with no reachable UI, so the page itself must offer sign-out (e.g. to
// free a shared/borrowed browser). Same shape as HostSignOut.jsx.

import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function SignOutButton() {
  const router = useRouter()
  async function signOut() {
    // scope:'local' — this device only (global default revokes every session).
    try { await createBrowserClient().auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
    router.push('/login')
    router.refresh()
  }
  return (
    <button
      type="button"
      onClick={signOut}
      className="text-sm text-white/40 hover:text-white transition-colors underline underline-offset-4"
    >
      Sign out on this device
    </button>
  )
}
