'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

// Routes that should NOT show the CRM sidebar
const publicPaths = ['/login', '/book/', '/unsubscribe/', '/preferences/']

export default function AppShell({ children, user }) {
  const pathname = usePathname()
  const isPublic = publicPaths.some(p => pathname.startsWith(p))

  if (isPublic) {
    return children
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
