// REPORT-ISSUE.2 — interactive inbox UI for owner / master.
//
// Tabs across the four statuses (open + in_progress collapsed into
// "Open" since they share the same handler queue), list of issues,
// drill-in drawer with the photo carousel + Claim / Resolve / Close
// actions. All mutation goes through /api/issues/[id]/{claim,
// resolve, close}; the list re-fetches after each one.

'use client'

import { useEffect, useState, useCallback } from 'react'
import { Loader2, AlertCircle, Image as ImageIcon, CheckCircle2, X, Lock, Send } from 'lucide-react'

const TABS = [
  { key: 'open',     label: 'Open',         statuses: ['open', 'in_progress'] },
  { key: 'resolved', label: 'Resolved',     statuses: ['resolved'] },
  { key: 'closed',   label: 'Closed',       statuses: ['closed'] },
]

const STATUS_TONE = {
  open:        { fg: 'text-amber-200', bg: 'bg-amber-500/10', border: 'border-amber-500/30', label: 'Open' },
  in_progress: { fg: 'text-blue-200',  bg: 'bg-blue-500/10',  border: 'border-blue-500/30',  label: 'In progress' },
  resolved:    { fg: 'text-green-200', bg: 'bg-green-500/10', border: 'border-green-500/30', label: 'Resolved' },
  closed:      { fg: 'text-un1t-subtle', bg: 'bg-un1t-border/30', border: 'border-un1t-border', label: 'Closed' },
}

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function IssuesInbox() {
  const [tab, setTab] = useState('open')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const statuses = TABS.find((t) => t.key === tab).statuses.join(',')
    try {
      const r = await fetch(`/api/issues/inbox?status=${statuses}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        setRows([])
        return
      }
      setRows(j.data || [])
    } catch (e) {
      setError(e.message || 'Network error')
      setRows([])
    }
  }, [tab])

  useEffect(() => { setRows(null); load() }, [load])

  if (error) {
    return (
      <div className="text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center gap-1 mb-4 border-b border-un1t-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? 'border-un1t-text text-un1t-text font-semibold'
                : 'border-transparent text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
          <CheckCircle2 size={28} className="text-un1t-muted mx-auto mb-2" />
          <div className="text-sm font-semibold text-un1t-text">All clear</div>
          <div className="text-[12px] text-un1t-subtle mt-1">
            {tab === 'open' ? 'No open issues at this studio.' : `No ${tab} issues to show.`}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {rows.map((r) => {
            const tone = STATUS_TONE[r.status] || STATUS_TONE.open
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className="text-left bg-un1t-surface border border-un1t-border hover:bg-un1t-border/30 rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`${tone.bg} ${tone.border} ${tone.fg} text-[10px] uppercase tracking-wider font-semibold border rounded-full px-2 py-0.5`}>
                      {tone.label}
                    </span>
                    {Array.isArray(r.issue_attachments) && r.issue_attachments.length > 0 && (
                      <span className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                        <ImageIcon size={11} /> {r.issue_attachments.length}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-un1t-subtle">{timeAgo(r.created_at)}</span>
                </div>
                <div className="text-sm text-un1t-text truncate-2">{r.description}</div>
                <div className="text-[11px] text-un1t-subtle mt-1">
                  {r.submitter?.full_name || 'Staff'}{r.claimant?.full_name ? ` · claimed by ${r.claimant.full_name}` : ''}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {selectedId && (
        <IssueDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => { load() }}
        />
      )}
    </>
  )
}

// ───────────────────────────────────────────────────────────────
// Drawer — single-issue drill-in with handler actions
// ───────────────────────────────────────────────────────────────

function IssueDrawer({ id, onClose, onChanged }) {
  const [issue, setIssue] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)   // 'claim' | 'resolve' | 'close'
  const [resolving, setResolving] = useState(false)
  const [notes, setNotes] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/issues/${id}/inbox`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      setError(null)
      setIssue(j.data)
    } catch (e) {
      setError(e.message || 'Network error')
    }
  }, [id])

  useEffect(() => { load() }, [load])

  async function act(path, kind) {
    setBusy(kind); setError(null)
    try {
      const opts = { method: 'POST' }
      if (kind === 'resolve') {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = JSON.stringify({ notes: notes.trim() })
      }
      const r = await fetch(`/api/issues/${id}/${path}`, opts)
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `${kind} failed (${r.status})`)
        return
      }
      setIssue(j.data)
      onChanged?.()
      if (kind === 'resolve') {
        setResolving(false)
        setNotes('')
      }
    } finally {
      setBusy(null)
    }
  }

  const tone = issue ? (STATUS_TONE[issue.status] || STATUS_TONE.open) : STATUS_TONE.open
  const canClaim   = issue?.status === 'open'
  const canResolve = issue?.status === 'open' || issue?.status === 'in_progress'
  const canClose   = issue?.status === 'resolved'

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-un1t-surface border border-un1t-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-un1t-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`${tone.bg} ${tone.border} ${tone.fg} text-[10px] uppercase tracking-wider font-semibold border rounded-full px-2 py-0.5`}>
              {tone.label}
            </span>
            <span className="text-[11px] text-un1t-subtle">{issue ? timeAgo(issue.created_at) : ''}</span>
          </div>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text p-1">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!issue ? (
            <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div>
                <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Reported by</div>
                <div className="text-sm text-un1t-text">{issue.submitter?.full_name || 'Staff'}</div>
                {issue.locations?.name && (
                  <div className="text-[11px] text-un1t-subtle mt-0.5">{issue.locations.name}</div>
                )}
              </div>

              <div>
                <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Description</div>
                <div className="text-sm text-un1t-text whitespace-pre-wrap">{issue.description}</div>
              </div>

              {Array.isArray(issue.issue_attachments) && issue.issue_attachments.length > 0 && (
                <PhotoStrip issueId={issue.id} attachments={issue.issue_attachments} />
              )}

              {issue.status === 'in_progress' && issue.claimant?.full_name && (
                <div className="text-[12px] text-blue-200 bg-blue-500/10 border border-blue-500/30 rounded p-2 inline-flex items-start gap-2">
                  <Lock size={12} className="mt-0.5 shrink-0" /> Claimed by {issue.claimant.full_name}
                </div>
              )}

              {(issue.status === 'resolved' || issue.status === 'closed') && (
                <div className="bg-green-500/10 border border-green-500/30 rounded p-3">
                  <div className="text-xs uppercase tracking-wider text-green-200 font-semibold mb-1">
                    Resolved{issue.resolver?.full_name ? ` by ${issue.resolver.full_name}` : ''}
                  </div>
                  <div className="text-sm text-un1t-text whitespace-pre-wrap">
                    {issue.resolution_notes || '—'}
                  </div>
                </div>
              )}

              {error && (
                <div className="text-[12px] text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
                  <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
            </>
          )}
        </div>

        {issue && (
          <div className="p-5 border-t border-un1t-border space-y-3">
            {resolving ? (
              <>
                <label className="block text-xs text-un1t-subtle mb-1.5">Resolution notes (sent to the reporter)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was fixed / replaced / cleaned?"
                  maxLength={2000}
                  rows={4}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => { setResolving(false); setNotes('') }} className="text-un1t-subtle hover:text-un1t-text text-sm px-3 py-1.5">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => act('resolve', 'resolve')}
                    disabled={busy === 'resolve' || notes.trim().length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50"
                  >
                    {busy === 'resolve' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    Mark resolved
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-end gap-2">
                {canClaim && (
                  <button
                    type="button"
                    onClick={() => act('claim', 'claim')}
                    disabled={busy === 'claim'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-border/40 text-un1t-text text-sm font-semibold hover:bg-un1t-border/60 disabled:opacity-50"
                  >
                    {busy === 'claim' ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                    Claim
                  </button>
                )}
                {canResolve && (
                  <button
                    type="button"
                    onClick={() => setResolving(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-600 text-white text-sm font-semibold hover:bg-green-700"
                  >
                    <CheckCircle2 size={12} /> Mark resolved
                  </button>
                )}
                {canClose && (
                  <button
                    type="button"
                    onClick={() => act('close', 'close')}
                    disabled={busy === 'close'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-border/40 text-un1t-text text-sm font-semibold hover:bg-un1t-border/60 disabled:opacity-50"
                  >
                    {busy === 'close' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                    Close
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// Photo strip — signed-URL render of each attachment
// ───────────────────────────────────────────────────────────────

function PhotoStrip({ issueId, attachments }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">Photos</div>
      <div className="grid grid-cols-3 gap-2">
        {attachments
          .slice()
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((a) => (
            <Photo key={a.id} issueId={issueId} attachment={a} />
          ))}
      </div>
    </div>
  )
}

function Photo({ issueId, attachment }) {
  // Reuses the submitter-side signed-URL endpoint (which has owner
  // semantics for `submitter_id` check). Since handlers may NOT be
  // the submitter, this would 404. So we hit the inbox-specific
  // signed-URL endpoint instead.
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/issues/${issueId}/inbox/attachments/${attachment.id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (j.success === false || !j.data?.url) { setErr(true); return }
        setUrl(j.data.url)
      })
      .catch(() => alive && setErr(true))
    return () => { alive = false }
  }, [issueId, attachment.id])

  if (err) {
    return (
      <div className="aspect-square bg-un1t-bg/40 border border-un1t-border rounded-md flex items-center justify-center">
        <AlertCircle size={14} className="text-amber-400" />
      </div>
    )
  }
  if (!url) {
    return (
      <div className="aspect-square bg-un1t-bg/40 border border-un1t-border rounded-md flex items-center justify-center">
        <Loader2 size={14} className="text-un1t-subtle animate-spin" />
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="" className="w-full aspect-square object-cover rounded-md border border-un1t-border" />
    </a>
  )
}
