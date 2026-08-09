'use client'

// COMMSFIX.F.4 (mig 510) — per-link click report for a sent campaign.
//
// Lives in its own file rather than inline in CampaignDetail so the panel is
// testable on its own and so CampaignDetail's diff stays three lines (there is
// an open PR rewriting that file's header and controls).
//
// UNIQUE CLICKERS IS THE HEADLINE, deliberately. One enthusiastic person
// clicking a link five times is not five people, and total clicks is the
// number that flatters. Total sits beside it in a quieter weight, and the
// share bar is scaled against the top link — the panel answers "which of these
// links won", not "what share of recipients clicked".

import { useEffect, useState } from 'react'
import { MousePointerClick, ExternalLink } from 'lucide-react'

const MAX_URL_CHARS = 60

/** Display form: drop the scheme noise, cap the length. `title` keeps it all. */
function shortenUrl(url) {
  const bare = String(url).replace(/^https?:\/\//, '')
  return bare.length > MAX_URL_CHARS ? `${bare.slice(0, MAX_URL_CHARS - 1)}…` : bare
}

export default function CampaignLinkReport({ campaignId }) {
  const [state, setState] = useState({ status: 'loading', rows: [] })

  useEffect(() => {
    let live = true
    setState({ status: 'loading', rows: [] })

    ;(async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/links`)
        const body = await res.json()
        if (!live) return
        if (!res.ok || !body.success) {
          setState({ status: 'error', rows: [] })
          return
        }
        setState({ status: 'ready', rows: body.data || [] })
      } catch {
        // No retry button: this panel is one of several on the page and a
        // refresh is the honest recovery. Failing loudly beats a spinner that
        // never resolves, which is the state this replaces.
        if (live) setState({ status: 'error', rows: [] })
      }
    })()

    return () => { live = false }
  }, [campaignId])

  const { status, rows } = state
  const topUnique = rows.reduce((max, r) => Math.max(max, r.unique_clickers || 0), 0)

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">
          Link clicks
        </h3>
        {status === 'ready' && rows.length > 0 && (
          <span className="text-xs bg-cyan-500/10 text-cyan-700 px-2 py-0.5 rounded-full">
            {rows.length} {rows.length === 1 ? 'link' : 'links'}
          </span>
        )}
      </div>

      {status === 'loading' && (
        <p className="text-sm text-un1t-subtle py-4">Loading link report…</p>
      )}

      {status === 'error' && (
        <p className="text-sm text-red-700 py-4">
          Couldn&apos;t load the link report. Refresh the page to try again.
        </p>
      )}

      {status === 'ready' && rows.length === 0 && (
        <div className="py-6 text-center">
          <MousePointerClick size={28} className="mx-auto mb-2 text-un1t-subtle" />
          <p className="text-sm text-un1t-subtle">No link clicks recorded yet.</p>
        </div>
      )}

      {status === 'ready' && rows.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-end gap-6 text-xs text-un1t-muted uppercase tracking-wider">
            <span className="w-16 text-right">People</span>
            <span className="w-16 text-right">Clicks</span>
          </div>

          {rows.map((row) => {
            const unique = row.unique_clickers || 0
            const share = topUnique > 0 ? Math.round((unique / topUnique) * 100) : 0
            return (
              <div key={row.url} data-link-row className="space-y-1.5">
                <div className="flex items-center justify-between gap-6">
                  <a
                    href={row.url}
                    title={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-un1t-text hover:underline truncate flex items-center gap-1.5 min-w-0"
                  >
                    <ExternalLink size={12} className="shrink-0 text-un1t-subtle" />
                    <span className="truncate">{shortenUrl(row.url)}</span>
                  </a>
                  <div className="flex items-center gap-6 shrink-0 tabular-nums">
                    <span className="w-16 text-right text-sm font-semibold">{unique}</span>
                    <span className="w-16 text-right text-sm text-un1t-subtle">{row.clicks || 0}</span>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-un1t-border/60 overflow-hidden">
                  <div data-share-bar className="h-full rounded-full bg-cyan-600" style={{ width: `${share}%` }} />
                </div>
              </div>
            )
          })}

          <p className="text-xs text-un1t-muted pt-1">
            People = how many different contacts clicked that link. Clicks counts every click,
            including repeats.
          </p>
        </div>
      )}
    </div>
  )
}
