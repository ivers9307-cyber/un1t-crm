'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Button, Card, Modal } from '@/components/ui'
import { followupChip, placementCadence } from './BoardList'

// RAILS.4 — keyed by the board's placement cadence (placementCadence).
export const TURN_ON_CONFIRM = {
  nightly: 'People who already qualify are placed tonight without any messages. From tomorrow, new people get the follow-ups.',
  hourly: 'People who already qualify are placed within the hour without any messages. After that, new people get the follow-ups.',
}
export const DRY_RUN_ERRORS_NOTE = (n) => `Some people could not be checked (${n}). The first placement is held until this is clear.`

/** "3 people now on the €39 Trial board would move here". */
export function overlapLine(row) {
  const n = Number(row?.count) || 0
  const name = row?.boardName || row?.boardKey || 'another'
  return `${n} ${n === 1 ? 'person' : 'people'} now on the ${name} board would move here`
}

const LIVE_STATES = ['live', 'awaiting_approval']

async function postJson(url) {
  const res = await fetch(url, { method: 'POST' })
  let json = null
  try { json = await res.json() } catch { /* a non-JSON failure falls through to the generic message */ }
  if (!res.ok || !json?.success) throw new Error(json?.error || 'Something went wrong. Try again.')
  return json.data
}

/**
 * PIPEBUILD.5j — the launch panel: follow-up states, the dry run, Turn on.
 * No wizard coupling: Task 11's settings page mounts it with a saved board.
 *
 * @param {object} props
 * @param {{ id: string, name?: string, enabled?: boolean, stages?: object[] }} props.board
 * @param {object[]} props.followups  rows with stage_id and state
 * @param {{ key: string, label: string, error: string }[]} [props.issues]  installs that failed
 * @param {(key: string) => void} [props.onRetry]
 * @param {boolean} [props.installing]  an install is still running: Turn on waits
 * @param {string[]|null} [props.expectedKeys]  pack keys that must each have a row or an issue first
 * @param {boolean|null} [props.hasWhatsapp]  false: the studio has no WhatsApp number on, and the note says so
 * @param {(board: object) => void} [props.onEnabled]
 * @param {boolean} [props.showBoardLink]
 */
export default function BoardLaunchPanel({ board, followups, issues = [], onRetry, retryDisabled = false, installing = false, expectedKeys = null, hasWhatsapp = null, onEnabled, showBoardLink = false }) {
  const [dry, setDry] = useState(null)
  const [dryBusy, setDryBusy] = useState(false)
  const [dryError, setDryError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [onBusy, setOnBusy] = useState(false)
  const [onError, setOnError] = useState(null)
  const [enabled, setEnabled] = useState(!!board.enabled)
  const inFlight = useRef(false)

  const stages = [...(board.stages || [])]
  const hasFollowup = (followups || []).some((f) => LIVE_STATES.includes(f.state))
  const settled = !installing && (expectedKeys == null
    || expectedKeys.every((k) => (followups || []).some((f) => f.pack_key === k) || issues.some((i) => i.key === k)))
  const canTurnOn = !!dry && hasFollowup && settled && !enabled
  // The dry run answers a count, or (older shape) the list of errors.
  const dryErrors = dry ? (Array.isArray(dry.errors) ? dry.errors.length : Number(dry.errors) || 0) : 0

  async function runDry() {
    if (inFlight.current) return
    inFlight.current = true
    setDryBusy(true); setDryError(null)
    try {
      setDry(await postJson(`/api/pipelines/${board.id}/dry-run`))
    } catch (e) {
      setDryError(e.message)
    } finally {
      inFlight.current = false
      setDryBusy(false)
    }
  }

  async function turnOn() {
    if (inFlight.current) return
    inFlight.current = true
    setOnBusy(true); setOnError(null)
    try {
      const data = await postJson(`/api/pipelines/${board.id}/enable`)
      setEnabled(true); setConfirming(false)
      onEnabled?.(data.board)
    } catch (e) {
      setOnError(e.message)
    } finally {
      inFlight.current = false
      setOnBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-lg font-semibold text-un1t-text">Follow-ups</h2>
        <ul className="space-y-1">
          {stages.map((st) => {
            const chip = followupChip(followups, st.id)
            return (
              <li key={st.id} className="flex items-center gap-2 text-sm text-un1t-text">
                <span>{st.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${chip.tone}`}>{chip.label}</span>
              </li>
            )
          })}
        </ul>
        {issues.length > 0 && (
          <ul className="mt-3 space-y-2" role="alert">
            {issues.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-2 text-sm text-red-700">
                <span>{i.label}: {i.error}</span>
                {onRetry && <Button type="button" size="sm" variant="secondary" disabled={retryDisabled} onClick={() => onRetry(i.key)}>Try again</Button>}
              </li>
            ))}
          </ul>
        )}
        {!hasFollowup && (
          <p className="mt-3 text-sm text-un1t-subtle">The board needs at least one live follow-up, or one waiting for Meta, before it can be turned on.{hasWhatsapp === false && ' This studio has no WhatsApp number switched on, so a follow-up cannot be submitted yet.'}</p>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-un1t-text">Who would enter</h2>
        <Button type="button" variant="secondary" loading={dryBusy} onClick={runDry}>Check who would enter</Button>
        {dryError && <p className="mt-2 text-sm text-red-700" role="alert">{dryError}</p>}
        {dry && (
          <div className="mt-3 space-y-2 text-sm text-un1t-text">
            <p><strong>{dry.entering}</strong> {dry.entering === 1 ? 'person would' : 'people would'} enter this board.</p>
            <ul className="space-y-0.5">
              {(dry.byStage || []).map((s) => <li key={s.slug}>{s.name}: {s.count}</li>)}
            </ul>
            {(dry.overlap || []).length > 0 && (
              <ul className="space-y-0.5 text-un1t-subtle">
                {dry.overlap.map((o) => <li key={o.boardKey}>{overlapLine(o)}</li>)}
              </ul>
            )}
            {dryErrors > 0 && <p className="text-amber-700">{DRY_RUN_ERRORS_NOTE(dryErrors)}</p>}
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {enabled
          ? <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-700">On</span>
          : <Button type="button" disabled={!canTurnOn} onClick={() => setConfirming(true)}>Turn on</Button>}
        {showBoardLink && <Link href={`/settings/pipelines/${board.id}`} className="text-sm text-un1t-accent">Open the board</Link>}
        {!enabled && !settled && <span className="text-sm text-un1t-subtle">Installing follow-ups…</span>}
        {!enabled && !dry && <span className="text-sm text-un1t-subtle">Check who would enter first.</span>}
      </div>

      <Modal
        open={confirming}
        onClose={() => { if (!onBusy) setConfirming(false) }}
        title="Turn on this board"
        footer={(
          <>
            <Button type="button" variant="secondary" disabled={onBusy} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" loading={onBusy} onClick={turnOn}>Turn on</Button>
          </>
        )}
      >
        <p className="text-sm text-un1t-text">{TURN_ON_CONFIRM[placementCadence(board)]}</p>
        {onError && <p className="mt-2 text-sm text-red-700" role="alert">{onError}</p>}
      </Modal>
    </div>
  )
}
