'use client'
// LinkedAccountsCard.jsx — PERSON-LINK.1
//
// Shows all linked accounts in a person_group and lets the operator
// make a contact primary or unlink it. When the contact isn't grouped
// (person === null) shows a slim "not linked" call-to-action.
//
// Props:
//   person      — aggregatePerson() payload or null
//   contactId   — id of the contact whose page we're on (string UUID)
//   locationId  — active location id (string UUID)
//
// Mutations call the link API:
//   POST   /api/contacts/{id}/link?action=set-primary  → make primary
//   DELETE /api/contacts/{id}/link                     → unlink
// On success: router.refresh() to reload server-side data.
// On failure: inline error per row (doesn't crash the card).
//
// Confirmation uses the native confirm() pattern (same as
// ContactEditDeleteActions.jsx in this codebase).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link2, AlertCircle } from 'lucide-react'
import { Card, Button } from '@/components/ui'
import { initials, accountStatusLabel, accountStatusTone, formatLastSeen } from '@/lib/person-view'
import dynamic from 'next/dynamic'

// Lazy-load the link modal so the contact page doesn't pay its
// search-input JS cost on initial render.
const LinkAccountModal = dynamic(() => import('./LinkAccountModal'), { ssr: false })

// ─── Row component ─────────────────────────────────────────────────────────

function AccountRow({ account, onSetPrimary, onUnlink, busy, error }) {
  const { name, status, glofoxMemberId, isPrimary, attended30d, lastAttendedAt } = account
  const abbr = initials(name)
  const labelText = accountStatusLabel(status)
  const toneCls = accountStatusTone(status)
  const isBusy = busy?.contactId === account.contactId ? busy.action : null

  // Per-account activity summary: "6 visits/30d · last 12 Jun 2026"
  // Only render when there's at least one piece of activity data.
  const hasActivity = (attended30d > 0) || lastAttendedAt
  const activityLine = hasActivity
    ? [
        attended30d > 0 ? `${attended30d} visit${attended30d === 1 ? '' : 's'}/30d` : null,
        `last ${formatLastSeen(lastAttendedAt)}`,
      ].filter(Boolean).join(' · ')
    : null

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-un1t-border/50 last:border-b-0">
      {/* Avatar */}
      <div
        aria-hidden="true"
        className="flex-none h-8 w-8 rounded-full bg-un1t-text/[0.06] flex items-center justify-center text-xs font-semibold text-un1t-text"
      >
        {abbr}
      </div>

      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-un1t-text truncate">{name || '—'}</span>
          {isPrimary && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-un1t-text/[0.08] text-un1t-text">
              Primary
            </span>
          )}
          {status && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${toneCls}`}>
              {labelText}
            </span>
          )}
        </div>
        {glofoxMemberId && (
          <p className="text-[11px] text-un1t-muted mt-0.5">Member #{glofoxMemberId}</p>
        )}
        {/* Per-account activity strip — shows which account carries the visits */}
        {activityLine && (
          <p className="text-[11px] text-un1t-muted mt-0.5">{activityLine}</p>
        )}
        {error && error.contactId === account.contactId && (
          <p className="text-[11px] text-red-700 mt-0.5 flex items-center gap-1">
            <AlertCircle size={10} className="shrink-0" />
            {error.message}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex-none flex items-center gap-1">
        {!isPrimary && (
          <Button
            variant="ghost"
            size="sm"
            loading={isBusy === 'primary'}
            disabled={!!busy}
            onClick={() => onSetPrimary(account.contactId)}
          >
            Make primary
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          loading={isBusy === 'unlink'}
          disabled={!!busy}
          onClick={() => onUnlink(account.contactId, name)}
        >
          Unlink
        </Button>
      </div>
    </div>
  )
}

// ─── Main card ─────────────────────────────────────────────────────────────

export default function LinkedAccountsCard({ person, contactId, locationId }) {
  const router = useRouter()
  const [modalOpen, setModalOpen] = useState(false)
  // busy: { contactId, action } or null
  const [busy, setBusy] = useState(null)
  // error: { contactId, message } or null
  const [rowError, setRowError] = useState(null)

  const accounts = person?.accounts || []
  const hasMultiple = accounts.length >= 2

  async function handleSetPrimary(targetContactId) {
    if (!window.confirm('Make this the primary account? The primary contact is the one used for outreach and de-duplication.')) return
    setBusy({ contactId: targetContactId, action: 'primary' })
    setRowError(null)
    try {
      const r = await fetch(`/api/contacts/${targetContactId}/link?action=set-primary`, {
        method: 'POST',
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setRowError({ contactId: targetContactId, message: j.error || `Failed (${r.status})` })
      } else {
        router.refresh()
      }
    } catch (e) {
      setRowError({ contactId: targetContactId, message: e?.message || 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  async function handleUnlink(targetContactId, name) {
    const label = name || 'this account'
    if (!window.confirm(`Unlink ${label} from this person group? The account will become standalone again.`)) return
    setBusy({ contactId: targetContactId, action: 'unlink' })
    setRowError(null)
    try {
      const r = await fetch(`/api/contacts/${targetContactId}/link`, {
        method: 'DELETE',
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setRowError({ contactId: targetContactId, message: j.error || `Failed (${r.status})` })
      } else {
        router.refresh()
      }
    } catch (e) {
      setRowError({ contactId: targetContactId, message: e?.message || 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Card
        title="Linked accounts"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={Link2}
            onClick={() => setModalOpen(true)}
          >
            {hasMultiple ? 'Link another' : 'Link a duplicate'}
          </Button>
        }
      >
        {hasMultiple ? (
          <div>
            {accounts.map((account) => (
              <AccountRow
                key={account.contactId}
                account={account}
                onSetPrimary={handleSetPrimary}
                onUnlink={handleUnlink}
                busy={busy}
                error={rowError}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-un1t-subtle">
            This contact isn&apos;t linked to any other accounts. Use &ldquo;Link a duplicate&rdquo; to group multiple Glofox or ClassPass accounts that belong to the same real person.
          </p>
        )}
      </Card>

      {modalOpen && (
        <LinkAccountModal
          contactId={contactId}
          locationId={locationId}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
