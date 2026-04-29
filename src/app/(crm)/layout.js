import Sidebar from '@/components/Sidebar'
import { getCurrentUser } from '@/lib/supabase'
import { redirect } from 'next/navigation'

export default async function CRMLayout({ children }) {
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar user={user} />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
