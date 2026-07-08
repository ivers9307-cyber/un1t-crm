'use client'

// Host-portal sign-out (HOST-PORTAL.1).

import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function HostSignOut() {
  const router = useRouter()
  async function signOut() {
    try { await createBrowserClient().auth.signOut() } catch { /* ignore */ }
    router.push('/host/login')
    router.refresh()
  }
  return (
    <button type="button" onClick={signOut} className="text-white/50 hover:text-white transition">
      Sign out
    </button>
  )
}
