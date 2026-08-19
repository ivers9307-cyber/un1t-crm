'use client'
// ContactDuplicatesView.jsx — PERSON-LINK.2
//
// Review queue for pending duplicate contact suggestions.
//
// Props:
//   suggestions  — person_link_suggestions rows (status='pending') with
//                  contact_a and contact_b embeds (disambiguated FK)
//   locationId   — active location id
//
// Features:
//   • "Scan for duplicates" → POST /api/contacts/duplicates/detect (dry-run)
//     Shows returned counts; a second "Apply" button commits.
//   • Pending suggestions table: contacts side-by-side, confidence chip,
//     reason, per-row Confirm / Dismiss actions.
//   • Per-row busy state and inline error.
//   • Empty state when queue is clear.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ScanLine, Users2, AlertCircle } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { accountStatusLabel, accountStatusTone, initials } from '@/lib/person-view'

// ─── Confidence chip ───────────────────────────────────────────────────────────

const CONFIDENCE_STYLES = {
  high:   'bg-emerald-500/10 text-emerald-700',
  medium: 'bg-amber-500/10 text-amber-700',
  low:    'bg-slate-500/10 text-slate-700',
}

function ConfidenceChip({ confidence }) {
  const cls = CONFIDENCE_STYLES[confidence] || CONFIDENCE_STYLES.low
  const label = confidence ? confidence.charAt(0).toUpperCase() + confidence.slice(1) : '—'
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  )
}

// ─── Contact mini-card ─────────────────────────────────────────────────────────

function ContactMini({ contact }) {
  if (!contact) {
    return <span className="text-un1t-muted text-sm italic">Unknown contact</span>
  }
  const abbr = initials(contact.name)
  const label = accountStatusLabel(contact.glofox_membership_status)
  const tone = accountStatusTone(contact.glofox_membership_status)

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div
        aria-hidden="true"
        className="flex-none h-8 w-8 rounded-full bg-un1t-text/[0.06] flex items-center justify-center text-xs font-semibold text-un1t-text"
      >
        {abbr}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-un1t-text truncate">{contact.name || '—'}</p>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          {contact.glofox_membership_status && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${tone}`}>{label}</span>
          )}
          {contact.email && (
            <span className="text-[11px] text-un1t-muted truncate">{contact.email}</span>
          )}
          {!contact.email && contact.phone && (
            <span className="text-[11px] text-un1t-muted">{contact.phone}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Suggestion row ────────────────────────────────────────────────────────────

function SuggestionRow({ suggestion, onAction }) {
  const [busy, setBusy] = useState(null) // 'linked' | 'dismissed'
  const [error, setError] = useState(null)

  async function handleAction(status) {
    setBusy(status)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/duplicates/${suggestion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        setError(json.error || `Failed (${res.status})`)
      } else {
        onAction()
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-b border-un1t-border/50 last:border-b-0 py-4 px-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Contact A */}
        <div className="flex-1 min-w-0">
          <ContactMini contact={suggestion.contact_a} />
        </div>

        {/* Divider */}
        <div className="flex-none flex items-center justify-center">
          <Users2 size={16} className="text-un1t-muted" />
        </div>

        {/* Contact B */}
        <div className="flex-1 min-w-0">
          <ContactMini contact={suggestion.contact_b} />
        </div>

        {/* Meta */}
        <div className="flex-none flex flex-col items-end gap-1.5 min-w-[120px]">
          <ConfidenceChip confidence={suggestion.confidence} />
          {suggestion.reason && (
            <span className="text-[11px] text-un1t-muted text-right truncate max-w-[160px]" title={suggestion.reason}>
              {suggestion.reason}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex-none flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy === 'linked'}
            disabled={!!busy}
            onClick={() => handleAction('linked')}
          >
            Confirm
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={busy === 'dismissed'}
            disabled={!!busy}
            onClick={() => handleAction('dismissed')}
          >
            Dismiss
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-red-700 flex items-center gap-1">
          <AlertCircle size={11} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function ContactDuplicatesView({ suggestions, locationId }) {
  const router = useRouter()

  // Scan state
  const [scanResult, setScanResult] = useState(null) // dry-run counts
  const [scanBusy, setScanBusy] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyResult, setApplyResult] = useState(null)

  async function handleScan() {
    setScanBusy(true)
    setScanError(null)
    setScanResult(null)
    setApplyResult(null)
    try {
      const res = await fetch('/api/contacts/duplicates/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        setScanError(json.error || `Scan failed (${res.status})`)
      } else {
        setScanResult(json.data)
      }
    } catch (e) {
      setScanError(e?.message || 'Network error')
    } finally {
      setScanBusy(false)
    }
  }

  async function handleApply() {
    setApplyBusy(true)
    setScanError(null)
    try {
      const res = await fetch('/api/contacts/duplicates/detect?commit=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        setScanError(json.error || `Apply failed (${res.status})`)
      } else {
        setApplyResult(json.data)
        setScanResult(null)
        router.refresh()
      }
    } catch (e) {
      setScanError(e?.message || 'Network error')
    } finally {
      setApplyBusy(false)
    }
  }

  function handleRowAction() {
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Duplicate contacts</h1>
        <p className="text-sm text-un1t-muted mt-1">
          Review suggested duplicate contacts and confirm or dismiss each pair.
        </p>
      </div>

      {/* Scan card */}
      <Card>
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-un1t-text">Scan for new duplicates</p>
              <p className="text-xs text-un1t-muted mt-0.5">
                Detects new potential duplicates by phone number and name similarity.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={ScanLine}
              loading={scanBusy}
              onClick={handleScan}
            >
              Scan
            </Button>
          </div>

          {/* Dry-run results */}
          {scanResult && !applyResult && (
            <div className="rounded-lg bg-un1t-surface border border-un1t-border px-4 py-3 space-y-2">
              <p className="text-sm text-un1t-text font-medium">Scan results</p>
              <ul className="text-sm text-un1t-subtle space-y-0.5">
                <li>
                  <span className="text-emerald-700 font-medium">{scanResult.counts?.high ?? 0} high-confidence</span>{' '}
                  — will auto-link on apply
                </li>
                <li>
                  <span className="text-amber-700 font-medium">{scanResult.counts?.medium ?? 0} medium</span>{' '}
                  + <span className="text-slate-700 font-medium">{scanResult.counts?.low ?? 0} low</span>{' '}
                  — added to review queue
                </li>
              </ul>
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={applyBusy}
                onClick={handleApply}
              >
                Apply
              </Button>
            </div>
          )}

          {/* Apply result */}
          {applyResult && (
            <p className="text-sm text-emerald-700">
              Done — {applyResult.autoLinked ?? 0} auto-linked,{' '}
              {(applyResult.counts?.medium ?? 0) + (applyResult.counts?.low ?? 0)} added to review queue.
            </p>
          )}

          {scanError && (
            <p className="text-sm text-red-700 flex items-center gap-1">
              <AlertCircle size={13} className="shrink-0" />
              {scanError}
            </p>
          )}
        </div>
      </Card>

      {/* Pending suggestions */}
      <Card title={`Review queue (${suggestions.length})`}>
        {suggestions.length === 0 ? (
          <div className="p-8 text-center">
            <Users2 size={32} className="mx-auto text-un1t-muted mb-3" />
            <p className="text-sm font-medium text-un1t-text">Queue is clear</p>
            <p className="text-xs text-un1t-muted mt-1">
              No pending duplicate suggestions. Run a scan to find new ones.
            </p>
          </div>
        ) : (
          <div>
            {suggestions.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} onAction={handleRowAction} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
