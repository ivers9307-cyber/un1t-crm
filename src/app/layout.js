import './globals.css'
import AppShellServer from '@/components/AppShellServer'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Analytics } from '@vercel/analytics/next'

export const metadata = {
  title: 'UN1T CRM',
  description: 'Lead management for UN1T',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppShellServer>{children}</AppShellServer>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  )
}
