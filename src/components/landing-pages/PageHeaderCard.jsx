'use client'
// PAGES.1 — the page editor's header card (/settings/landing-page/<id>): the
// title (state lifted to LandingPageSettingsForm, saved by its Save), the
// path with Rename (a campaign page only: PUT { slug }), the status chip and
// its buttons (POST …/publish), the scope (read-only), and on a studio page
// the un1t.online terms copy (chrome.un1t_terms, lifted and saved like the
// title). Every answer the API returns is lifted with onPageChange so the chip
// and the path follow it.
//
// Rendered OUTSIDE the editor's <form>, so Enter in the rename or redirect
// input never submits the page. Client bundle: pure modules only.

import { useState } from 'react'
import { Button, Card } from '@/components/ui'
import { slugProblem, normaliseSlug } from '@/lib/page-slug'
import { DEFAULT_FUNNEL_TERMS_COPY, UN1T_FUNNEL_COPY_KEYS } from '@/lib/un1t-online-funnel-copy'

// Same chips as the Pages list.
const STATUS_CHIPS = Object.freeze({
  live: { label: 'Live', className: 'bg-green-500/10 text-green-700' },
  draft: { label: 'Draft', className: 'bg-gray-500/10 text-gray-700' },
  coming_soon: { label: 'Coming soon', className: 'bg-amber-500/10 text-amber-700' },
  retired: { label: 'Retired', className: 'bg-gray-500/10 text-gray-700' },
})
const CHIP = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'

// The buttons each state offers: [target state, label].
const STATE_ACTIONS = Object.freeze({
  draft: [['live', 'Publish'], ['coming_soon', 'Mark coming soon']],
  live: [['draft', 'Unpublish'], ['retired', 'Retire']],
  coming_soon: [['live', 'Publish'], ['draft', 'Back to draft']],
  retired: [['draft', 'Back to draft']],
})

const SLUG_MESSAGES = Object.freeze({
  reserved: 'That path is reserved.',
  taken: 'That path is already taken.',
  invalid: 'Use letters, numbers and dashes only, 2 to 40 characters.',
})
const NOT_READY_REASONS = Object.freeze({ needs_plan: 'needs a plan', no_platform: 'has no platform' })
const PUBLISH_MESSAGES = Object.freeze({
  redirect_required: 'Give the path to send visitors to.',
  studio_page: 'A studio page cannot be retired.',
})
const REDIRECT_HINT = 'Use a path on this site that starts with /, like /trial.'

const TERMS_LABELS = Object.freeze({
  terms_label: 'Terms tick label',
  terms_link_label: 'Terms link text',
  waiver_link_label: 'Waiver link text',
  terms_required_message: 'Message when the tick is missing',
  legal_unavailable_message: 'Message when a document cannot load',
})

const INPUT = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-60'

function notReadyMessage(studios) {
  const list = Array.isArray(studios) ? studios : []
  if (list.length === 0) return 'Not ready to go live: no studio is switched on.'
  const named = list.map((s) => `${s.name || 'A studio'} (${NOT_READY_REASONS[s.reason] || s.reason})`)
  return `Not ready to go live: ${named.join(', ')}.`
}

const redirectOk = (v) => v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\')

async function call(url, method, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.success !== false, status: r.status, j }
}

export default function PageHeaderCard({
  page, studios = [], canEdit, title, onTitleChange, onPageChange, terms = {}, onTermsChange,
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [slugDraft, setSlugDraft] = useState(page.slug)
  const [retiring, setRetiring] = useState(false)
  const [redirectTo, setRedirectTo] = useState('/trial')

  const isStudio = page.kind === 'studio'
  const chip = STATUS_CHIPS[page.publish_state] || STATUS_CHIPS.draft
  const actions = (STATE_ACTIONS[page.publish_state] || STATE_ACTIONS.draft)
    .filter(([state]) => !(isStudio && state === 'retired'))
  const primary = studios.find((s) => s.location_id === page.primary_location_id)
  const scopeLabel = page.scope === 'all' ? 'All studios' : `One studio: ${primary?.name || 'Studio'}`

  async function publish(state, redirect) {
    setBusy(true)
    setMessage(null)
    try {
      const body = { publish_state: state, ...(redirect ? { redirect_to: redirect } : {}) }
      const { ok, j } = await call(`/api/landing-pages/${page.id}/publish`, 'POST', body)
      if (!ok) {
        setMessage(j.error === 'not_ready' ? notReadyMessage(j.studios) : PUBLISH_MESSAGES[j.error] || j.error || 'The status could not be changed.')
        return
      }
      setRetiring(false)
      onPageChange?.(j.data)
    } catch {
      setMessage('The status could not be changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function onAction(state) {
    if (state === 'retired') { setMessage(null); setRetiring(true); return }
    publish(state)
  }

  function confirmRetire() {
    const path = redirectTo.trim()
    if (!redirectOk(path)) { setMessage(REDIRECT_HINT); return }
    publish('retired', path)
  }

  async function saveSlug() {
    const problem = slugProblem(slugDraft)
    if (problem) { setMessage(SLUG_MESSAGES[problem]); return }
    setBusy(true)
    setMessage(null)
    try {
      const { ok, j } = await call(`/api/landing-pages/${page.id}`, 'PUT', { slug: normaliseSlug(slugDraft) })
      if (!ok) {
        // A 500 after the rename itself landed (the old address got no
        // redirect) still carries the renamed page: follow it.
        if (j.data) onPageChange?.(j.data)
        setMessage(SLUG_MESSAGES[j.error] || j.error || 'The path could not be changed.')
        return
      }
      setRenaming(false)
      onPageChange?.(j.data)
    } catch {
      setMessage('The path could not be changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (fn) => (e) => { if (e.key === 'Enter') { e.preventDefault(); fn() } }

  return (
    <Card className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <div>
          <label htmlFor="page-title" className="block text-xs font-medium text-un1t-subtle mb-1">Title</label>
          <input
            id="page-title" className={INPUT} value={title} maxLength={120} disabled={!canEdit}
            onChange={(e) => onTitleChange?.(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`${CHIP} ${chip.className}`}>{chip.label}</span>
          {canEdit && actions.map(([state, label]) => (
            <Button key={state} type="button" size="sm" variant={state === 'live' ? 'primary' : 'secondary'} disabled={busy} onClick={() => onAction(state)}>
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-sm text-un1t-subtle">
        <span>Path <code className="text-un1t-text">/{page.slug}</code></span>
        {canEdit && !isStudio && !renaming && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { setSlugDraft(page.slug); setMessage(null); setRenaming(true) }}>Rename</Button>
        )}
        <span>{scopeLabel}</span>
        {page.publish_state === 'retired' && page.redirect_to && (
          <span>Redirects to <code className="text-un1t-text">{page.redirect_to}</code></span>
        )}
      </div>

      {renaming && (
        <div className="space-y-2">
          <label htmlFor="page-slug" className="block text-xs font-medium text-un1t-subtle">New path</label>
          <div className="flex items-center gap-2">
            <input id="page-slug" className={INPUT} value={slugDraft} maxLength={40} onChange={(e) => setSlugDraft(e.target.value)} onKeyDown={onEnter(saveSlug)} />
            <Button type="button" size="sm" loading={busy} onClick={saveSlug}>Save path</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setRenaming(false); setMessage(null) }}>Cancel</Button>
          </div>
          {page.publish_state === 'live' && <p className="text-xs text-un1t-muted">The old address will redirect to the new one.</p>}
        </div>
      )}

      {retiring && (
        <div className="space-y-2">
          <label htmlFor="page-redirect" className="block text-xs font-medium text-un1t-subtle">Send visitors to</label>
          <div className="flex items-center gap-2">
            <input id="page-redirect" className={INPUT} value={redirectTo} maxLength={300} onChange={(e) => setRedirectTo(e.target.value)} onKeyDown={onEnter(confirmRetire)} />
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={confirmRetire}>Retire page</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setRetiring(false); setMessage(null) }}>Cancel</Button>
          </div>
        </div>
      )}

      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}

      {isStudio && (
        <div className="space-y-2 border-t border-un1t-border pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">un1t.online terms copy</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {UN1T_FUNNEL_COPY_KEYS.map((key) => (
              <div key={key}>
                <label htmlFor={`page-terms-${key}`} className="block text-xs font-medium text-un1t-subtle mb-1">{TERMS_LABELS[key]}</label>
                <input
                  id={`page-terms-${key}`} className={INPUT} maxLength={400} disabled={!canEdit}
                  value={terms?.[key] || ''} placeholder={DEFAULT_FUNNEL_TERMS_COPY[key]}
                  onChange={(e) => onTermsChange?.({ ...terms, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {!canEdit && (
        <p className="text-sm text-un1t-muted">
          You can view this page but not edit it. {page.scope === 'all' ? 'An organisation admin edits all-studios pages.' : 'Ask an owner at this studio.'}
        </p>
      )}
    </Card>
  )
}
