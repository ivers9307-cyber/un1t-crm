'use client'

// NewEmailPicker — NEWEMAIL.1: blank first, then the studio's marketing
// templates. Picking one creates the draft (POST /api/communications/campaigns,
// with template_id for a template) and opens it in the full editor. Props are
// plain data only: a function prop from the server page crashes it in production.
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FilePlus2, LayoutTemplate, Loader2 } from 'lucide-react'
import { campaignPath, campaignRequest } from '@/lib/campaign-route-client'

// `audience` (QUICKEMAIL-RETIRE.1): { label, filter } from a Segments link,
// sent as the draft's audience_filter; { missing: true } when the link's
// segment could not be read; null for a plain start.
export default function NewEmailPicker({ locationId, studioName = '', templates = [], readFailed = false, audience = null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(null) // 'blank' | template id
  const [error, setError] = useState(null)

  async function start(template) {
    const key = template ? template.id : 'blank'
    setBusy(key)
    setError(null)
    const result = await campaignRequest(campaignPath(), {
      method: 'POST',
      body: {
        location_id: locationId,
        name: template ? template.name : 'Untitled email',
        ...(template ? { template_id: template.id } : {}),
        ...(audience?.filter ? { audience_filter: audience.filter } : {}),
      },
    })
    if (!result.ok || !result.data?.id) {
      setError(result.error || 'Could not create the email. Try again.')
      setBusy(null)
      return
    }
    router.push(`/communications/sent/email/${result.data.id}?edit=1`)
  }

  const tile = 'w-full text-left rounded-2xl border border-un1t-border bg-un1t-surface p-4 hover:border-un1t-text/30 transition-colors disabled:opacity-50'

  return (
    <div className="max-w-3xl">
      <Link href="/communications/sent" className="text-xs text-un1t-subtle hover:text-un1t-text">← Sent</Link>
      <h1 className="text-xl font-semibold text-un1t-text mt-1">New email</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        Start blank or from one of {studioName ? `${studioName}'s` : 'the studio’s'} templates. It opens in the full editor as a draft; nothing is sent.
      </p>

      {audience?.filter && (
        <p className="mb-4 text-sm text-un1t-text">Audience: <span className="font-medium">{audience.label}</span>. You can change it in the editor.</p>
      )}
      {audience?.missing && (
        <p className="mb-4 text-sm text-amber-700">That segment could not be found at this studio, so the email starts with no audience. Pick one in the editor.</p>
      )}

      {error && <p role="alert" className="mb-4 text-sm text-rose-700">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" className={tile} onClick={() => start(null)} disabled={busy !== null}>
          <span className="flex items-center gap-2 text-sm font-semibold text-un1t-text">
            {busy === 'blank' ? <Loader2 size={16} className="animate-spin" /> : <FilePlus2 size={16} />} Blank
          </span>
          <span className="block text-xs text-un1t-subtle mt-1">An empty design.</span>
        </button>
        {templates.map((t) => (
          <button key={t.id} type="button" className={tile} onClick={() => start(t)} disabled={busy !== null}>
            <span className="flex items-center gap-2 text-sm font-semibold text-un1t-text">
              {busy === t.id ? <Loader2 size={16} className="animate-spin" /> : <LayoutTemplate size={16} />} {t.name}
            </span>
            {(t.description || t.subject) && (
              <span className="block text-xs text-un1t-subtle mt-1 truncate">{t.description || t.subject}</span>
            )}
          </button>
        ))}
      </div>

      {readFailed ? (
        <p className="mt-4 text-xs text-amber-700">The studio&apos;s templates could not be read just now, so only Blank is offered. Reload to try again.</p>
      ) : templates.length === 0 ? (
        <p className="mt-4 text-xs text-un1t-subtle">
          No marketing templates yet. <Link href="/communications/templates" className="underline hover:text-un1t-text">Save one under Templates</Link> and it shows up here.
        </p>
      ) : null}
    </div>
  )
}
