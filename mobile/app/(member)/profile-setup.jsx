import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/member/contact-context'
import ProfileSetupWizard from '../../components/member/ProfileSetupWizard'
import { setDismissedNow } from '../../lib/member/profile-setup-dismissal'

// Single mount point for the profile-setup wizard. Auto-presented by the
// ProfileSetupGate in _layout.jsx, and reused by the home nudge card (Task 6)
// which pushes '/profile-setup' directly.
export default function ProfileSetupRoute() {
  const router = useRouter()
  const { contact, refresh } = useAuth()
  return (
    <ProfileSetupWizard
      contact={contact}
      onDone={async () => {
        await refresh()
        if (router.canGoBack()) router.back()
        else router.replace('/home')
      }}
      onDismiss={async () => {
        await setDismissedNow()
        if (router.canGoBack()) router.back()
        else router.replace('/home')
      }}
    />
  )
}
