'use client'

// ZOOMOPS.1 — write controls for the Zoom Phone contact sync.
//
// Posts to POST /api/integrations/zoom-contacts/run, which enforces its own
// permission gate — this component only DECIDES WHAT TO OFFER, it is not the
// security boundary. `canManage` is computed server-side in page.js with the
// exact same check the route runs (hasPermissionInOrganization), so a viewer
// who would get a 403 never sees a button that produces one.
//
// Run now defaults its limit to 200, never blank — an unlimited manual run
// enqueues one QStash job per pending write (thousands on a cold directory),
// so the expensive path must be a deliberate choice, never the default.

import { useState } from 'react'
import { Button, Modal, Field } from '@/components/ui'

const RUN_ROUTE = '/api/integrations/zoom-contacts/run'
const DEFAULT_RUN_LIMIT = 200

async function postRun(body) {
  let res
  try {
    res = await fetch(RUN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { httpOk: false, envelopeError: err?.message || 'Network error', data: null }
  }
  let json = null
  try { json = await res.json() } catch { /* non-JSON body */ }
  if (!res.ok) {
    return { httpOk: false, envelopeError: json?.error || `Request failed (${res.status})`, data: null }
  }
  // A 200 can still carry success:false when the SYNC (not the request)
  // failed — e.g. Zoom down, or the guard tripped. That is not a request
  // error: it is a result, and summarise() below is what renders it.
  return { httpOk: true, envelopeError: null, data: json?.data ?? null }
}

function summarise(out) {
  if (!out) return null
  if (out.skipped) {
    return out.skipped === 'unconfigured'
      ? 'Skipped — Zoom is not configured (ZOOM_* secrets unset).'
      : `Skipped — ${out.skipped}`
  }
  if (out.error) return `Error: ${out.error}`
  const c = out.counts || {}
  const bits = [`+${c.creates ?? 0} ~${c.updates ?? 0} -${c.deletes ?? 0}`]
  if (Number.isFinite(out.enqueued)) bits.push(`${out.enqueued} enqueued`)
  if (out.limited) bits.push('limit reached — more remain for the next run')
  if (out.guardTripped) bits.push(`guard tripped — ${out.guard?.attempted ?? '?'} deletions refused`)
  // ZOOMSYNC.4 — say it out loud on every run. These are members with no name
  // on the handsets, and the whole point of the change is that the sync stops
  // retrying them silently; a suppression nobody can see is the bug it replaced.
  const w = out.withheld || {}
  if (w.invalid) bits.push(`${w.invalid} number${w.invalid === 1 ? '' : 's'} Zoom will not accept — see below`)
  if (w.parked) bits.push(`${w.parked} parked after a permanent Zoom error`)
  if (w.deletes) bits.push(`${w.deletes} deletion${w.deletes === 1 ? '' : 's'} withheld (unusable number still in Zoom)`)
  return bits.join(' · ')
}

export default function Controls({ canManage, initialGuard }) {
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState(null)
  const [previewError, setPreviewError] = useState(null)

  const [limit, setLimit] = useState(String(DEFAULT_RUN_LIMIT))
  const [limitError, setLimitError] = useState(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [runError, setRunError] = useState(null)

  // Seeded from the last STORED run so the button/modal aren't empty before
  // any click, then kept fresh from this viewer's own live responses — safe
  // because canManage is a precondition for ever seeing this button, and the
  // route never redacts the guard for a canManage caller (redaction is only
  // for the open-to-managers preview exemption). Reading stale numbers into a
  // deletion confirmation would be worse than reading none.
  const [guard, setGuard] = useState(initialGuard)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [overrideError, setOverrideError] = useState(null)

  const applyGuardFromResult = (out) => {
    if (!out) return
    if (out.guardTripped && out.guard) {
      setGuard({
        tripped: true,
        sample: Array.isArray(out.guard.sample) ? out.guard.sample : [],
        threshold: out.guard.threshold,
        attempted: out.guard.attempted,
      })
    } else if (out.guardTripped === false) {
      setGuard(null)
    }
  }

  const handlePreview = async () => {
    setPreviewing(true)
    setPreviewError(null)
    const { httpOk, envelopeError, data } = await postRun({ dry: true })
    setPreviewing(false)
    if (!httpOk) {
      setPreviewError(envelopeError)
      setPreviewResult(null)
      return
    }
    setPreviewResult(data)
    if (canManage) applyGuardFromResult(data)
  }

  const handleRun = async () => {
    const n = Number(limit)
    if (!Number.isFinite(n) || n <= 0) {
      setLimitError('Limit must be a positive number')
      return
    }
    setLimitError(null)
    setRunning(true)
    setRunError(null)
    const { httpOk, envelopeError, data } = await postRun({ dry: false, limit: n })
    setRunning(false)
    if (!httpOk) {
      setRunError(envelopeError)
      setRunResult(null)
      return
    }
    setRunResult(data)
    applyGuardFromResult(data)
  }

  const handleOverrideConfirm = async () => {
    setOverriding(true)
    setOverrideError(null)
    const { httpOk, envelopeError, data } = await postRun({ dry: false, force: true })
    setOverriding(false)
    if (!httpOk) {
      setOverrideError(envelopeError)
      return
    }
    setRunResult(data)
    applyGuardFromResult(data)
    setOverrideOpen(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" variant="secondary" loading={previewing} onClick={handlePreview}>
          Preview
        </Button>

        {canManage && (
          <>
            <Field id="zoom-run-limit" label="Limit" error={limitError} className="w-28">
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min="1"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="w-full rounded-md border border-un1t-border px-2 py-1.5 text-sm h-10"
                />
              )}
            </Field>

            <Button type="button" variant="primary" loading={running} onClick={handleRun}>
              Run now
            </Button>

            <Button
              type="button"
              variant="danger"
              disabled={!guard?.tripped}
              onClick={() => setOverrideOpen(true)}
            >
              Override guard
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {previewError && <p className="text-xs text-red-700">{previewError}</p>}
        {previewResult && <p className="text-xs text-un1t-subtle">Preview: {summarise(previewResult)}</p>}
        {runError && <p className="text-xs text-red-700">{runError}</p>}
        {runResult && <p className="text-xs text-un1t-subtle">Run: {summarise(runResult)}</p>}
      </div>

      {canManage && (
        <Modal
          open={overrideOpen}
          onClose={() => { if (!overriding) setOverrideOpen(false) }}
          title="Override the deletion guard"
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setOverrideOpen(false)} disabled={overriding}>
                Cancel
              </Button>
              <Button type="button" variant="danger" loading={overriding} onClick={handleOverrideConfirm}>
                Delete these numbers
              </Button>
            </>
          }
        >
          <p className="text-sm text-un1t-text mb-2">
            The deletion guard refused {guard?.attempted ?? 0} removal{guard?.attempted === 1 ? '' : 's'}
            {' '}(threshold {guard?.threshold ?? '—'}). Confirming runs the sync for real with the guard bypassed —
            every number below, and any others past this list, is deleted from the Zoom directory.
          </p>
          {guard?.sample?.length ? (
            <>
              <p className="text-xs text-un1t-muted mb-1">
                First {guard.sample.length} of {guard.attempted ?? guard.sample.length}:
              </p>
              <ul className="text-sm font-mono text-un1t-text mb-2 space-y-0.5 max-h-48 overflow-y-auto">
                {guard.sample.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </>
          ) : (
            <p className="text-xs text-un1t-muted mb-2">No sample numbers available.</p>
          )}
          {overrideError && <p className="text-xs text-red-700">{overrideError}</p>}
        </Modal>
      )}
    </div>
  )
}
