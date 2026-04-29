import { getCurrentUser } from '@/lib/supabase'
import AppShell from './AppShell'

export default async function AppShellServer({ children }) {
  const user = await getCurrentUser()
  return <AppShell user={user}>{children}</AppShell>
}
