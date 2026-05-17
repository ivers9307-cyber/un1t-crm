// Public BCA-pack download page.
//
// The token in the URL is the only credential — no auth. Lives at
// /bca/<token> rather than under /cars/ so it doesn't inherit any
// app-level auth gate. The trust boundary is the 24-byte URL-safe
// random token minted at submit time (~190 bits of entropy, infeasible
// to guess); RLS doesn't need to special-case the row read because
// `createServerClient()` uses the service-role key, and the page
// itself enforces the "is this token valid + not expired" check.
//
// Renders three states:
//   - 404 / unknown token / superseded → "Not found"
//   - past download_expires_at         → "Expired" page with operator
//                                         contact pointer
//   - happy path                       → claim header (car + dates)
//                                         + merged PDF hero download
//                                         + per-doc download list
//
// Signed URLs for each file are minted at render time with a 1h TTL.
// That's plenty for a single sit-down download session; reloading
// the page mints fresh ones if the operator parks the tab for longer.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { BCA_DOWNLOAD_WINDOW_DAYS } from '@/lib/bca'
import { recordBcaPageView } from '@/lib/bca-events'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata({ params }) {
  const db = createServerClient()
  const { data: row } = await db
    .from('car_bca_submissions')
    .select('email_subject, cars ( make, model, vehicle_year, uk_reg, locations ( company_settings ( company_name, favicon_url ) ) )')
    .eq('download_token', params.token)
    .maybeSingle()
  if (!row) return { title: 'BCA download' }
  const settings = row.cars?.locations?.company_settings?.[0] || {}
  const carLabel = [row.cars?.uk_reg, row.cars?.make, row.cars?.model, row.cars?.vehicle_year]
    .filter(Boolean).join(' ')
  const title = [settings.company_name, `BCA download${carLabel ? ` — ${carLabel}` : ''}`]
    .filter(Boolean).join(' — ')
  const icons = settings.favicon_url ? { icon: settings.favicon_url } : undefined
  return { title, icons }
}

export default async function BcaDownloadPage({ params }) {
  const db = createServerClient()

  const { data: row } = await db
    .from('car_bca_submissions')
    .select(`
      id, email_subject, submitted_at,
      documents, merged_pdf_path, merged_pdf_size,
      download_expires_at, superseded_at,
      cars ( uk_reg, irish_reg, vin, make, model, vehicle_year ),
      locations ( company_settings ( company_name, logo_url ) )
    `)
    .eq('download_token', params.token)
    .maybeSingle()

  if (!row) notFound()

  const now = Date.now()
  const expiresAt = row.download_expires_at ? new Date(row.download_expires_at).getTime() : 0
  const expired = !expiresAt || expiresAt <= now

  const settings = row.locations?.company_settings?.[0] || {}
  const car = row.cars || {}

  if (expired) {
    return (
      <ExpiredState
        companyName={settings.company_name}
        logoUrl={settings.logo_url}
        carLabel={[car.uk_reg, car.make, car.model].filter(Boolean).join(' ')}
        expiredAt={row.download_expires_at}
      />
    )
  }

  // Log this page view (best-effort — never block the render on it).
  // Counts + first/last viewed roll up onto the submission row for
  // the operator-side BcaSubmitCard.
  try {
    const h = headers()
    const ip = (h.get('x-forwarded-for') || '').split(',')[0].trim() || h.get('x-real-ip') || null
    const ua = h.get('user-agent') || null
    await recordBcaPageView(db, row.id, { ip, userAgent: ua })
  } catch {
    // Swallow — tracking failure must not break the page.
  }

  // Downloads go through tracking-redirect endpoints rather than
  // direct Supabase signed URLs, so we capture WHICH file BCA
  // actually pulled (not just that the page was opened).
  const mergedDownloadUrl = row.merged_pdf_path ? `/api/public/bca/${params.token}/merged` : null
  const docs = Array.isArray(row.documents) ? row.documents : []
  const docsForRender = docs.map(d => ({
    ...d,
    download_url: d?.slug && d?.storage_path ? `/api/public/bca/${params.token}/file/${d.slug}` : null,
  }))

  const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / (24 * 3600 * 1000)))
  const carLabel = [car.uk_reg, car.make, car.model, car.vehicle_year]
    .filter(Boolean).join(' ')

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-2xl mx-auto p-6">
        {settings.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={settings.logo_url} alt={settings.company_name || ''} className="h-12 mb-6 object-contain" />
        )}

        <h1 className="text-2xl font-bold">BCA document pack</h1>
        {carLabel && <p className="text-sm text-zinc-600 mt-1">{carLabel}{car.vin ? ` · VIN ${car.vin}` : ''}</p>}
        <p className="text-xs text-zinc-500 mt-2">
          Submitted {new Date(row.submitted_at).toLocaleDateString()}.
          Available here for {daysLeft} more day{daysLeft === 1 ? '' : 's'}.
        </p>

        {mergedDownloadUrl && (
          <section className="mt-8 border-2 border-zinc-900 rounded-lg p-5 bg-white">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-2">Merged pack</h2>
            <p className="text-sm text-zinc-700 mb-4">
              All {docs.length} document{docs.length === 1 ? '' : 's'} combined into a single PDF —
              this is exactly what was emailed.
            </p>
            <a
              href={mergedDownloadUrl}
              className="inline-flex items-center justify-center gap-2 w-full px-4 py-3 rounded-md bg-zinc-900 text-white font-semibold hover:bg-zinc-700"
            >
              Download merged PDF ({(row.merged_pdf_size / 1024).toFixed(0)} KB)
            </a>
          </section>
        )}

        <section className="mt-6 border border-zinc-300 rounded-lg p-5 bg-white">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Individual documents ({docs.length})
          </h2>
          <ul className="divide-y divide-zinc-200">
            {docsForRender.map((d, i) => (
              <li key={d.slug || i} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-zinc-400">{d.slug?.toUpperCase()}</div>
                  <div className="text-sm text-zinc-900 truncate" title={d.label}>{d.label}</div>
                  <div className="text-xs text-zinc-500 truncate" title={d.filename}>
                    {d.filename} · {(d.size_bytes / 1024).toFixed(0)} KB
                  </div>
                </div>
                {d.download_url ? (
                  <a
                    href={d.download_url}
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-zinc-300 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
                  >
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-zinc-400 italic shrink-0">unavailable</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-8 text-xs text-zinc-500">
          These files are available for {BCA_DOWNLOAD_WINDOW_DAYS} days after the submission was sent.
          If you need access after that, ask the sender to resubmit the pack from their CRM.
        </p>
      </div>
    </div>
  )
}

function ExpiredState({ companyName, logoUrl, carLabel, expiredAt }) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-zinc-300 rounded-lg p-6 text-center">
        {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName || ''} className="h-10 mx-auto mb-4 object-contain" />
        )}
        <h1 className="text-xl font-bold">Download window expired</h1>
        {carLabel && <p className="text-sm text-zinc-600 mt-1">{carLabel}</p>}
        <p className="text-sm text-zinc-700 mt-4">
          The {BCA_DOWNLOAD_WINDOW_DAYS}-day download window for this BCA pack ended
          {expiredAt ? ` on ${new Date(expiredAt).toLocaleDateString()}` : ''}.
        </p>
        <p className="text-sm text-zinc-600 mt-3">
          Contact {companyName || 'the sender'} and ask them to resubmit the pack — they'll get a new
          link automatically.
        </p>
        <Link href="/" className="inline-block mt-6 text-xs text-zinc-500 hover:text-zinc-900 underline">
          ← {companyName || 'Home'}
        </Link>
      </div>
    </div>
  )
}
