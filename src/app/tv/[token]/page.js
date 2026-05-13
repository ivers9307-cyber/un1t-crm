// /tv/[token] — public TV display page.
//
// What the UC Cast Pro loads as its Web URL content source.
// Fullscreen, no chrome, black background. Token-gated (the
// URL is the secret). Polls /api/tv/[token]/content every 3s
// to detect pushes.

import TVDisplay from './TVDisplay'
import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Single-screen viewport: lock to the device's natural size,
// no zoom UI. The cast almost always renders 1920×1080 but
// the meta keeps the layout sane on any aspect ratio.
export const metadata = {
  title: 'UN1T',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
}

export default async function TVPage({ params }) {
  // Pre-fetch initial content server-side so the screen renders
  // immediately without waiting for the first client-side poll.
  // Re-use the same handler the client polls so the shape is
  // identical.
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
    // Don't leak that we found-or-didn't-find a display — just
    // show a generic message. The TV will display this until the
    // operator pastes a valid URL.
    return (
      <div style={{ background: '#000', color: '#444', fontFamily: 'system-ui', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>
        Invalid display URL.
      </div>
    )
  }

  return <TVDisplay token={params.token} initial={initial} />
}
