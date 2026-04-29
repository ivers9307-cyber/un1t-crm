import './globals.css'
import AppShellServer from '@/components/AppShellServer'

export const metadata = {
  title: 'UN1T CRM',
  description: 'Lead management for UN1T',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppShellServer>{children}</AppShellServer>
      </body>
    </html>
  )
}
