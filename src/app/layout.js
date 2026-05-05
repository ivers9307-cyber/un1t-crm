import './globals.css'
import AppShellServer from '@/components/AppShellServer'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Analytics } from '@vercel/analytics/next'

// The favicon lives in Supabase Storage (uploaded via
// /settings → BrandingSettings) so non-developers can swap it.
// Wiring it through Next's root metadata gets a <link rel="icon">
// emitted on every page including the buyer-facing deposit and
// race signup pages on pay.ccfautos.com — those don't render the
// Sidebar component which used to be the only place the favicon
// got injected (imperatively, client-side, after auth). The
// timestamp cache-buster is intentionally omitted — Supabase
// Storage serves the same path forever and the browser's own
// cache handles invalidation cheaply enough.
const FAVICON_URL =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/a0000000-0000-0000-0000-000000000001/favicon.png'

export const metadata = {
  title: 'UN1T CRM',
  description: 'Lead management for UN1T',
  icons: {
    icon: FAVICON_URL,
    shortcut: FAVICON_URL,
    apple: FAVICON_URL,
  },
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
