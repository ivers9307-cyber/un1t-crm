'use client'
// PAGES.1 — the New page form: title, path, which studios, offer type and an
// optional page to start from. The path is pre-checked against
// GET /api/landing-pages/slug-check 300 ms after the last keystroke (with the
// chosen studio for a one-studio page, so it judges the organisation POST
// will create the page in), and Create stays off until that check answers
// "available" for the path and studio as they now read. POST /api/landing-pages is the authority (it re-checks the path
// and the caller's rights); a created page opens in its editor.
//
// Client bundle: pure modules only, never @/lib/landing-pages or @/lib/auth.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Modal } from '@/components/ui'
import { OFFER_TYPES, OFFER_TYPE_LABELS, OFFER_TYPE_DESCRIPTIONS } from '@/lib/landing-page-offers'
import { normaliseSlug } from '@/lib/page-slug'

const SLUG_CHECK_DELAY_MS = 300

const SLUG_MESSAGES = Object.freeze({
  reserved: 'That path is reserved.',
  taken: 'That path is already taken.',
  invalid: 'Use letters, numbers and dashes only, 2 to 40 characters.',
  unchecked: 'The path could not be checked. Try again in a moment.',
})

const CREATE_ERRORS = Object.freeze({
  reserved: SLUG_MESSAGES.reserved,
  taken: SLUG_MESSAGES.taken,
  invalid: SLUG_MESSAGES.invalid,
  primary_location_required: 'Pick a studio for this page.',
  not_found: 'The page to start from could not be found.',
  unavailable: 'Pages are unavailable right now. Try again in a minute.',
})

/** The label and description an offer type shows in the picker (page-level words, not the block's). */
function offerTypeOption(offerType) {
  return {
    label: OFFER_TYPE_LABELS[offerType] || OFFER_TYPE_LABELS.none,
    description: OFFER_TYPE_DESCRIPTIONS[offerType] || OFFER_TYPE_DESCRIPTIONS.none,
  }
}

const INPUT = 'w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm text-un1t-text focus:outline-none focus:ring-2 focus:ring-un1t-accent'

export default function NewPageDialog({ open, onClose, pages = [], studios = [], canCreateAll = false }) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  // The last answer for a path at a studio: { slug, target, state: 'pending' | 'available' | <problem> }.
  const [check, setCheck] = useState(null)
  const [scope, setScope] = useState(studios.length > 0 ? 'one' : 'all')
  const [studioId, setStudioId] = useState(studios[0]?.id || '')
  const [offerType, setOfferType] = useState(OFFER_TYPES[0])
  const [startFrom, setStartFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const latest = useRef({ slug: '', target: '' })
  // The studio the check judges: the chosen one on a one-studio page, '' (the
  // active organisation) on an all-studios page.
  const target = scope === 'one' ? studioId : ''

  useEffect(() => () => clearTimeout(timer.current), [])

  async function runSlugCheck(value, at) {
    const normal = normaliseSlug(value)
    if (!normal) {
      setCheck({ slug: value, target: at, state: 'invalid' })
      return
    }
    let state = 'unchecked'
    try {
      const studioParam = at ? `&location_id=${encodeURIComponent(at)}` : ''
      const res = await fetch(`/api/landing-pages/slug-check?slug=${encodeURIComponent(normal)}${studioParam}`)
      const body = await res.json().catch(() => null)
      if (res.ok && body?.success) state = body.data?.available ? 'available' : (body.data?.problem || 'unchecked')
    } catch {
      state = 'unchecked'
    }
    if (latest.current.slug === value && latest.current.target === at) setCheck({ slug: value, target: at, state })
  }

  function scheduleCheck(value, at) {
    latest.current = { slug: value, target: at }
    clearTimeout(timer.current)
    if (!value.trim()) {
      setCheck(null)
      return
    }
    setCheck({ slug: value, target: at, state: 'pending' })
    timer.current = setTimeout(() => runSlugCheck(value, at), SLUG_CHECK_DELAY_MS)
  }

  function onSlugChange(e) {
    const value = e.target.value.toLowerCase()
    setSlug(value)
    scheduleCheck(value, target)
  }

  // A different studio (or scope) can mean a different organisation: check again.
  function onTargetChange(nextScope, nextStudioId) {
    setScope(nextScope)
    setStudioId(nextStudioId)
    const at = nextScope === 'one' ? nextStudioId : ''
    if (slug && at !== latest.current.target) scheduleCheck(slug, at)
  }

  const checked = check?.slug === slug && check.target === target
  const slugClean = checked && check.state === 'available'
  const slugError = checked ? SLUG_MESSAGES[check.state] : undefined
  const scopeOk = scope === 'all' ? canCreateAll : Boolean(studioId)
  const canSubmit = Boolean(title.trim()) && slugClean && scopeOk && !saving

  async function onSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/landing-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          slug: normaliseSlug(slug),
          kind: 'campaign',
          scope,
          primary_location_id: scope === 'one' ? studioId : null,
          offer_type: offerType,
          start_from_page_id: startFrom || null,
        }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.success && body.data?.id) {
        router.push(`/settings/landing-page/${body.data.id}`)
        return
      }
      setError(CREATE_ERRORS[body?.error] || body?.error || 'The page could not be created.')
    } catch {
      setError('The page could not be created. Check your connection and try again.')
    }
    setSaving(false)
  }

  const offer = offerTypeOption(offerType)

  return (
    <Modal open={open} onClose={onClose} title="New page" dismissOnBackdrop={false}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field id="new-page-title" label="Title">
          {(p) => <input {...p} type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />}
        </Field>

        <Field id="new-page-path" label="Path" hint={slug && !slugError ? `The page lives at /${slug}.` : undefined} error={slugError}>
          {(p) => (
            <input {...p} type="text" maxLength={40} autoComplete="off" spellCheck={false} value={slug} onChange={onSlugChange} className={INPUT} />
          )}
        </Field>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-un1t-text">Studios</legend>
          <div className="flex flex-wrap gap-4 text-sm text-un1t-text">
            {studios.length > 0 && (
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="new-page-scope" value="one" checked={scope === 'one'} onChange={() => onTargetChange('one', studioId)} />
                One studio
              </label>
            )}
            {canCreateAll && (
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="new-page-scope" value="all" checked={scope === 'all'} onChange={() => onTargetChange('all', studioId)} />
                All studios
              </label>
            )}
          </div>
        </fieldset>

        {scope === 'one' && studios.length > 0 && (
          <Field id="new-page-studio" label="Studio">
            {(p) => (
              <select {...p} value={studioId} onChange={(e) => onTargetChange(scope, e.target.value)} className={INPUT}>
                {studios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        )}

        <Field id="new-page-offer" label="Offer" hint={offer.description}>
          {(p) => (
            <select {...p} value={offerType} onChange={(e) => setOfferType(e.target.value)} className={INPUT}>
              {OFFER_TYPES.map((t) => <option key={t} value={t}>{offerTypeOption(t).label}</option>)}
            </select>
          )}
        </Field>

        <Field id="new-page-start" label="Start from" hint="Copies that page's content blocks. Leave blank to start blank.">
          {(p) => (
            <select {...p} value={startFrom} onChange={(e) => setStartFrom(e.target.value)} className={INPUT}>
              <option value="">Start blank</option>
              {pages.map((pg) => <option key={pg.id} value={pg.id}>{pg.title}</option>)}
            </select>
          )}
        </Field>

        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={!canSubmit}>Create page</Button>
        </div>
      </form>
    </Modal>
  )
}
