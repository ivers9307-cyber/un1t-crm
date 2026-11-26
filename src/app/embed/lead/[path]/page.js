// /embed/lead/[path] — EMBEDFORM.1: the paste-anywhere sign-up form for a
// studio, for a website, Linktree or any page that takes an <iframe>:
//
//   <iframe src="https://un1tdublin.com/embed/lead/stillorgan"
//           style="width:100%;max-width:480px;height:520px;border:0"></iframe>
//
// `path` is a studio page's public slug (the same key /api/public/leads takes
// as public_path). The studio, its tag and lead source are resolved on the
// server; the visitor's browser sends only name, email, phone and the box.
//
// Public with no allowlist edit: /embed/ is already on all four public-page
// lists and is the one subtree next.config.js lets other sites frame.

import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { resolvePublicPageRequest } from '@/lib/landing-pages'
import EmbedLeadForm from '@/components/EmbedLeadForm'

export const dynamic = 'force-dynamic'

async function resolve(path) {
  const db = createServerClient()
  const host = (await headers()).get('host')
  return resolvePublicPageRequest(db, { hostname: host, legacyPath: path, requireEnabled: false })
}

export async function generateMetadata(props) {
  const { path } = await props.params
  const r = await resolve(path).catch(() => null)
  const name = r?.ok ? (r.studioRow?.name || r.page?.title || '') : ''
  return { title: name ? `Join ${name}` : 'Sign up', robots: { index: false, follow: false } }
}

export default async function EmbedLeadPage(props) {
  const { path } = await props.params
  const r = await resolve(path)
  if (!r.ok) notFound()
  const studioName = r.studioRow?.name || ''
  return (
    <main className="min-h-screen bg-white p-4">
      <EmbedLeadForm publicPath={r.publicPath} studioName={studioName} />
    </main>
  )
}
