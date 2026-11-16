'use client'

// SEQSTART.1 (15 Nov feature audit, area 4) — the Start / Stop control for an
// "everyone who matches the audience" flow.
//
// Publishing such a flow enrols nobody: the */5 sweep refuses to run until
// email_sequences.audience_seeded_at is stamped, and only
// POST /api/sequences/[id]/audience/seed stamps it, after the operator confirms
// the exact number of people who match. The settings copy told operators to
// "start it once, from this page", but nothing on the page called that route,
// so every audience-match flow sat enrolling nobody.
//
// The number shown on the button is the one the settings panel's matching count
// returned; the route recounts and refuses a stale figure with the fresh one
// (409), which this shows so the operator can confirm again.

import { useState } from 'react'
import { Play, Square, AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui'

/**
 * @param {object}  sequence  needs id, status, audience_seeded_at, audience_seed_count
 * @param {number|null} matchingCount  the latest matching count, null while unknown
 * @param {boolean} dirty     unsaved settings: the route counts the SAVED audience
 */
export default function AudienceMatchStart({ sequence, matchingCount, dirty = false }) {
  const [seededAt, setSeededAt] = useState(sequence?.audience_seeded_at || null)
  const [seedCount, setSeedCount] = useState(sequence?.audience_seed_count ?? null)
  const [fresh, setFresh] = useState(null) // a recount the route answered with
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const count = fresh ?? matchingCount
  const live = sequence?.status === 'active'

  async function start() {
    if (count == null) return
    if (typeof window !== 'undefined' && !window.confirm(
      `Start this flow for ${count.toLocaleString()} ${count === 1 ? 'person' : 'people'}? They are enrolled over the next few minutes, and an enrolment cannot be undone.`,
    )) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/audience/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_count: count }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.success) {
        setSeededAt(body.data?.seeded_at || new Date().toISOString())
        setSeedCount(body.data?.matching ?? count)
        setFresh(null)
        setMessage({ ok: true, text: `Started. Enrolling ${count.toLocaleString()} over about ${body.data?.approx_minutes ?? 5} minutes.` })
      } else {
        if (res.status === 409 && Number.isInteger(body.data?.matching)) setFresh(body.data.matching)
        setMessage({ ok: false, text: body.error || 'Could not start this flow. Try again.' })
      }
    } catch {
      setMessage({ ok: false, text: 'Could not start this flow. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (typeof window !== 'undefined' && !window.confirm(
      'Stop enrolling new people? Everyone already in the flow carries on.',
    )) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/audience/seed`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.success) {
        setSeededAt(null)
        setSeedCount(null)
        setMessage({ ok: true, text: 'Stopped. Nobody new is enrolled; everyone already in carries on.' })
      } else {
        setMessage({ ok: false, text: body.error || 'Could not stop enrolling. Try again.' })
      }
    } catch {
      setMessage({ ok: false, text: 'Could not stop enrolling. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  let blocker = null
  if (!seededAt) {
    if (dirty) blocker = 'Save your settings first: the number is counted on the saved audience.'
    else if (count == null) blocker = 'Counting who matches…'
    else if (count === 0) blocker = 'Nobody matches the audience yet.'
  }

  return (
    <div className="mt-2 rounded-lg border border-un1t-border/70 bg-un1t-surface p-3 space-y-2" data-testid="audience-match-start">
      {seededAt ? (
        <>
          <p className="text-xs text-un1t-text">
            <span className="font-semibold">Started</span>{' '}
            {new Date(seededAt).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}
            {Number.isInteger(seedCount) ? ` for ${seedCount.toLocaleString()} ${seedCount === 1 ? 'person' : 'people'}` : ''}.
            {' '}Anyone who starts matching is enrolled within five minutes.
          </p>
          <Button type="button" variant="secondary" size="sm" icon={Square} loading={busy} disabled={busy} onClick={stop}>
            Stop enrolling new people
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-un1t-subtle">This flow has not been started, so it enrols nobody yet.</p>
          <Button type="button" variant="primary" size="sm" icon={Play} loading={busy} disabled={busy || blocker != null} onClick={start}>
            {count != null && count > 0 ? `Start for ${count.toLocaleString()} ${count === 1 ? 'person' : 'people'}` : 'Start'}
          </Button>
          {blocker && <p className="text-[11px] text-un1t-subtle">{blocker}</p>}
          {!blocker && !live && (
            <p className="text-[11px] text-un1t-subtle">Enrolment begins once the flow is published.</p>
          )}
        </>
      )}
      {message && (
        <p className={`text-xs flex items-center gap-1 ${message.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
          {message.ok ? <Check size={13} /> : <AlertTriangle size={13} />}{message.text}
        </p>
      )}
    </div>
  )
}
