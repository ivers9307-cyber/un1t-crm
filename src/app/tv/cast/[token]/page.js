// /tv/cast/[token] — public TV display page for UC Cast Pro.
//
// What the UC Cast Pro loads as its Web URL content source.
// Fullscreen, no chrome, black background. Token-gated (the URL
// is the secret). Polls /api/public/tv/[token]/content every
// 3s to detect pushes.
//
// Sibling to the HR live board at /tv/live/[token]. Both live
// under /tv/ (already public in middleware); each sits under its
// own static segment (cast/, live/) since Next.js refuses two
// different dynamic-segment names at the same path depth.

import TVDisplay from './TVDisplay'
import { cache } from 'react'
import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'

// Pre-fetch the display's content server-side so the screen renders
// immediately without waiting for the first client-side poll. React-cached
// per token so generateMetadata and the render share ONE request.
const loadInitial = cache(async (token) => {
  const proto = (await headers()).get('x-forwarded-proto') || 'https'
  const host  = (await headers()).get('host')
  const res = await fetch(`${proto}://${host}/api/public/tv/${token}/content`, {
    cache: 'no-store',
  }).catch(() => null)
  if (res?.ok) return { initial: await res.json().catch(() => null), invalid: false }
  return { initial: null, invalid: res?.status === 404 }
})

// W1.S1b — the tab names the display's studio brand (the content payload's
// display.company_name: company_settings → org_settings → locations.name),
// never a literal gym. The kiosk viewport is pinned here too.
export async function generateMetadata(props) {
  const params = await props.params
  const { initial } = await loadInitial(params.token)
  const brand = typeof initial?.display?.company_name === 'string' ? initial.display.company_name.trim() : ''
  return {
    ...(brand ? { title: brand } : {}),
    viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
  }
}

export default async function TVPage(props) {
  const params = await props.params;
  const { initial, invalid } = await loadInitial(params.token)

  if (invalid) {
    return (
      <div style={{ background: '#000', color: '#444', fontFamily: 'system-ui', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>
        Invalid display URL.
      </div>
    )
  }

  return <TVDisplay token={params.token} initial={initial} />
}
