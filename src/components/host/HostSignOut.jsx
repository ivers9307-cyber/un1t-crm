'use client'

// Host-portal sign-out (HOST-PORTAL.1).

import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { HOST_BTN_GHOST } from './host-ui'

export default function HostSignOut() {
  const router = useRouter()
  async function signOut() {
    // scope:'local' — this device only (global default revokes every session).
    try { await createBrowserClient().auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
    router.push('/host/login')
    router.refresh()
  }
  return (
    <button type="button" onClick={signOut} className={HOST_BTN_GHOST}>
      Sign out
    </button>
  )
}
