// /present/[token] — public fullscreen viewer. Mirrors /tv/cast/[token]:
// prefetch state server-side so the screen renders immediately.
import { headers } from 'next/headers'
import PresentViewer from './PresentViewer'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Presentation',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
}

export default async function PresentPage(props) {
  const params = await props.params
  const proto = (await headers()).get('x-forwarded-proto') || 'https'
  const host = (await headers()).get('host')
  const res = await fetch(`${proto}://${host}/api/public/presentations/${params.token}/state`, { cache: 'no-store' }).catch(() => null)
  let initial = null
  if (res?.ok) { const j = await res.json(); if (j.success) initial = j }
  return <PresentViewer token={params.token} initial={initial} />
}
