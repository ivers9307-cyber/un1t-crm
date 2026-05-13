// /tv/cast/[token] — public TV display page for UC Cast Pro.
//
// What the UC Cast Pro loads as its Web URL content source.
// Fullscreen, no chrome, black background. Token-gated (the URL
// is the secret). Polls /api/public/tv/[token]/content every
// 3s to detect pushes.
//
// Sibling to the HR live board at /tv/[locationId]. Both live
// under /tv/ (already public in middleware) but use different
// dynamic-segment names, so Next.js requires they sit at
// different path depths.

import TVDisplay from './TVDisplay'
import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export const metadata = {
  title: 'UN1T',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
}

export default async function TVPage({ params }) {
  // Pre-fetch initial content server-side so the screen renders
  // immediately without waiting for the first client-side poll.
  const proto = headers().get('x-forwarded-proto') || 'https'
  const host  = headers().get('host')
  const initialRes = await fetch(`${proto}://${host}/api/public/tv/${params.token}/content`, {
    cache: 'no-store',
  }).catch(() => null)

  let initial = null
  let invalid = false
  if (initialRes?.ok) {
    initial = await initialRes.json()
  } else if (initialRes?.status === 404) {
    invalid = true
  }

  if (invalid) {
    return (
      <div style={{ background: '#000', color: '#444', fontFamily: 'system-ui', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>
        Invalid display URL.
      </div>
    )
  }

  return <TVDisplay token={params.token} initial={initial} />
}
