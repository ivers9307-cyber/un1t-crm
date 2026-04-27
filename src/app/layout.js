import './globals.css'
import Sidebar from '@/components/Sidebar'

export const metadata = {
  title: 'UN1T CRM',
  description: 'Lead management for UN1T Dublin',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </body>
    </html>
  )
}
