// PHASE2 stage C — champ's ProfileSetupGate, ported from
// champ-app/mobile/app/_layout.jsx into the (member) tree. Auto-presents
// the profile-setup wizard once per app launch when a member's profile is
// incomplete and not recently dismissed. An auth-context-consuming,
// render-null side-effect component — mounted by app/(member)/_layout.jsx
// so it can only ever fire while the member shell is active (a staff-only
// session never sees it).

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/member/contact-context'
import { getDismissedAtMs } from '../../lib/member/profile-setup-dismissal'
import { profileSetupStatus } from 'shared/profile-setup'

export default function ProfileSetupGate() {
  const { contact, loading } = useAuth()
  const router = useRouter()
  const [dismissedAtMs, setDismissedAtMs] = useState(undefined) // undefined = not loaded yet
  const presentedRef = useRef(false)

  useEffect(() => { getDismissedAtMs().then((v) => setDismissedAtMs(v)) }, [])

  useEffect(() => {
    if (loading || dismissedAtMs === undefined || !contact) return
    const status = profileSetupStatus(contact, { dismissedAtMs })
    if (status === 'wizard' && !presentedRef.current) {
      presentedRef.current = true
      router.push('/profile-setup')
    }
  }, [loading, contact, dismissedAtMs, router])

  return null
}
