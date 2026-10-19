// UN1TWRITE.17 — /legal/un1t/[slug]/[doc]: a un1t.online studio's terms and
// conditions (doc 'terms') or liability waiver (doc 'waiver'), the two
// documents the class funnel's terms tick links to.
//
// slug = the studio's landing_page_settings.public_path. The text is
// un1t.online's own, read with the studio's token (readUn1tLegalDocs, cached
// an hour), because the snapshot marks those reads bearer-secured and a
// browser cannot fetch them itself. Rendered as TEXT (white-space: pre-wrap),
// never as HTML. A studio whose membership source is not un1t.online 404s.
// The headings are the operator's link labels and the failure message is the
// class_funnel block's legal_unavailable_message.
//
// Public reachability: '/legal/' is on all four allowlists already (proxy
// publicPaths, AppShell PUBLIC_PATHS, brands.js un1t-marketing,
// DB_BRAND_DEFAULTS); src/public-compliance-paths.test.jsx pins this path.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { resolveLandingPath } from '@/lib/public-landing'
import { readUn1tLegalDocs, legalDocPathFor } from '@/lib/un1t-online-legal'
import { un1tFunnelCopyFromBlocks, stripDashes } from '@/lib/un1t-online-funnel-copy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const metadata = { robots: { index: false } }

const OTHER = { terms: 'waiver', waiver: 'terms' }
const sentenceCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

async function loadStudio(slug) {
  const path = resolveLandingPath(slug)
  const db = createServerClient()
  const { data, error } = await db
    .from('landing_page_settings')
    .select('location_id, blocks, locations:location_id ( name, membership_source )')
    .eq('public_path', path)
    .maybeSingle()
  if (error || !data?.location_id) return null
  if (data.locations?.membership_source !== 'un1t_online') return null
  return { db, path, row: data }
}

export default async function Un1tLegalPage({ params }) {
  const { slug, doc } = await params
  if (!Object.hasOwn(OTHER, doc)) notFound()
  const studio = await loadStudio(slug)
  if (!studio) notFound()

  const copy = un1tFunnelCopyFromBlocks(studio.row.blocks)
  const labels = { terms: copy.terms_link_label, waiver: copy.waiver_link_label }
  const docs = await readUn1tLegalDocs(studio.db, studio.row.location_id)
  const shown = docs[doc]
  const other = OTHER[doc]
  const studioName = studio.row.locations?.name || ''

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-8">
          {studioName ? <p className="text-sm font-medium text-gray-500">{studioName}</p> : null}
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{sentenceCase(stripDashes(labels[doc]))}</h1>
        </header>
        {shown ? (
          <div className="text-sm leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>{shown.content}</div>
        ) : (
          <p className="text-sm text-gray-700">{stripDashes(copy.legal_unavailable_message)}</p>
        )}
        <p className="mt-10 text-sm">
          <a className="underline" href={legalDocPathFor(studio.path, other)}>{sentenceCase(stripDashes(labels[other]))}</a>
        </p>
      </div>
    </div>
  )
}
