'use client'

// REPSET-P5 — "App account" card on the contact command-centre page.
//
// The admin mechanism behind Richard's locked decision (17 Aug 2026):
// staff never self-link their member contact — the merged Repset app
// hard-disables self-linking when has_ever_been_staff is set, and a
// master/owner does the link HERE instead.
//
// The page only renders this card for master/owner (admin.canLinkAccount),
// and the route re-enforces that server-side — this component just drives
// /api/contacts/[id]/link-account:
//   - linked   → masked email (server-masked; the raw address never
//                reaches the browser) + staff chip for the dual case
//                + Unlink behind a confirm dialog
//   - unlinked → "Link app account" dialog: exact-email find (server-side
//                equality search, no fuzzy listing) → masked match →
//                explicit confirm → POST { userId, confirm: true }
//
// Deliberately absent: auth-user creation (that's Invite to App) and any
// one-click relink — an already-linked contact must be unlinked first
// (the route 409s, and we surface that verbatim).

import { useCallback, useEffect, useState } from 'react'
import { Smartphone, Search, Link2, Unlink } from 'lucide-react'
import { Modal, Button } from '@/components/ui'

// Light-theme chip recipe (bg-<c>-500/10 + text-<c>-700 — the -700 ramp
// is the contrast rule for text on light cards).
const CHIP = 'text-[11px] font-medium px-2 py-0.5 rounded-full'

function StaffChip() {
  return (
    <span className={`${CHIP} bg-amber-500/10 text-amber-700`} title="This auth user also has a staff profile — the dual staff+member case">
      Staff account
    </span>
  )
}

export default function ContactAppAccountCard({ contactId, contactName }) {
  const [state, setState] = useState(null)   // { linked, account } | null while loading
  const [loadError, setLoadError] = useState(null)

  // Dialog state — one dialog at a time: 'link' | 'unlink' | null.
  const [dialog, setDialog] = useState(null)
  const [email, setEmail] = useState('')
  const [search, setSearch] = useState(null) // null | { found, userId?, maskedEmail?, staff? }
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/link-account`)
      const j = await res.json()
      if (!res.ok || !j.success) {
        setLoadError(j.error || 'Could not load app-account state')
        return
      }
      setState(j.data)
    } catch (e) {
      setLoadError(e?.message || 'Could not load app-account state')
    }
  }, [contactId])

  useEffect(() => { load() }, [load])

  function closeDialog() {
    setDialog(null)
    setEmail('')
    setSearch(null)
    setDialogError(null)
    setBusy(false)
  }

  async function find() {
    setBusy(true)
    setDialogError(null)
    setSearch(null)
    try {
      const res = await fetch(
        `/api/contacts/${contactId}/link-account?email=${encodeURIComponent(email.trim())}`
      )
      const j = await res.json()
      if (!res.ok || !j.success) {
        setDialogError(j.error || 'Search failed')
        return
      }
      setSearch(j.data.search || { found: false })
    } catch (e) {
      setDialogError(e?.message || 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  async function confirmLink() {
    if (!search?.found) return
    setBusy(true)
    setDialogError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/link-account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: search.userId, confirm: true }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setDialogError(j.error || 'Link failed')
        return
      }
      closeDialog()
      await load()
    } catch (e) {
      setDialogError(e?.message || 'Link failed')
    } finally {
      setBusy(false)
    }
  }

  async function confirmUnlink() {
    setBusy(true)
    setDialogError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/link-account`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setDialogError(j.error || 'Unlink failed')
        return
      }
      closeDialog()
      await load()
    } catch (e) {
      setDialogError(e?.message || 'Unlink failed')
    } finally {
      setBusy(false)
    }
  }

  const account = state?.account || null

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
        <Smartphone size={12} /> App account
      </h3>

      {loadError && (
        <p className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 mb-2">
          {loadError}
        </p>
      )}

      {!state && !loadError && (
        <p className="text-sm text-un1t-muted">Loading…</p>
      )}

      {state && state.linked && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${CHIP} bg-emerald-500/10 text-emerald-700`}>
            {account?.maskedEmail || 'Linked (auth user missing)'}
          </span>
          {account?.staff && <StaffChip />}
          <Button variant="ghost" size="sm" icon={Unlink} onClick={() => setDialog('unlink')}>
            Unlink
          </Button>
        </div>
      )}

      {state && !state.linked && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-un1t-muted">No app account linked.</p>
          <Button variant="secondary" size="sm" icon={Link2} onClick={() => setDialog('link')}>
            Link app account
          </Button>
        </div>
      )}

      {/* ——— Link dialog ——— */}
      <Modal
        open={dialog === 'link'}
        onClose={closeDialog}
        title={`Link app account — ${contactName || 'contact'}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Button>
            {search?.found && (
              <Button variant="primary" loading={busy} onClick={confirmLink}>
                Confirm link
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-un1t-subtle">
            Enter the exact email of an existing app sign-in. This links the
            account — it never creates one (use “Invite to App” for that).
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (email.trim() && !busy) find() }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1 min-w-0 rounded-md border border-un1t-border bg-un1t-bg px-3 py-1.5 text-sm"
              autoFocus
            />
            <Button type="submit" variant="secondary" icon={Search} loading={busy} disabled={!email.trim()}>
              Find
            </Button>
          </form>

          {search && search.found && (
            <div className="flex flex-wrap items-center gap-2 border border-un1t-border rounded-md p-2.5">
              <span className={`${CHIP} bg-emerald-500/10 text-emerald-700`}>{search.maskedEmail}</span>
              {search.staff && <StaffChip />}
            </div>
          )}
          {search && !search.found && (
            <p className="text-sm text-un1t-muted">
              No app account with that email. This tool never creates accounts —
              send an app invite instead.
            </p>
          )}
          {dialogError && (
            <p className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {dialogError}
            </p>
          )}
        </div>
      </Modal>

      {/* ——— Unlink dialog ——— */}
      <Modal
        open={dialog === 'unlink'}
        onClose={closeDialog}
        title={`Unlink app account — ${contactName || 'contact'}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={confirmUnlink}>
              Unlink account
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-un1t-subtle">
            The member keeps their sign-in, but it will no longer be attached to
            this contact. Their app shows no member data until an admin relinks.
          </p>
          {account?.maskedEmail && (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${CHIP} bg-emerald-500/10 text-emerald-700`}>{account.maskedEmail}</span>
              {account?.staff && <StaffChip />}
            </div>
          )}
          {dialogError && (
            <p className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {dialogError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}
