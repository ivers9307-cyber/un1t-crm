'use client'

// One row per location on /settings/integrations. Shows the current
// connection state and offers a Connect / Disconnect / Reconnect
// action depending on the row's state. Also captures the per-org
// Xero "Email to Bills" address so the document → draft bill
// auto-forward has somewhere to send to.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink, Mail, Check, Database, Users } from 'lucide-react'

function fmt(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

// "5 min ago" / "2 hours ago" — short, friendly. Falls back to
// fmt() for anything older than a day so the operator gets the
// real timestamp instead of "23 hours ago" round-down ambiguity.
function fmtRelative(d) {
  if (!d) return 'Never synced'
  const t = new Date(d).getTime()
  if (!Number.isFinite(t)) return 'Never synced'
  const diffMs = Date.now() - t
  if (diffMs < 60_000) return 'just now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(diffMs / 3_600_000)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  return fmt(d)
}

export default function XeroLocationCard({ location, connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [billsEmail, setBillsEmail] = useState(connection?.bills_email_address || '')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailSaved, setEmailSaved] = useState(false)

  // XERO-API.1 — chart-of-accounts + contacts cache sync state.
  // Per-button busy flag so the user can fire both back-to-back
  // without one button getting wedged in a "Saving…" state.
  const [syncingAccounts, setSyncingAccounts] = useState(false)
  const [syncingContacts, setSyncingContacts] = useState(false)
  const [accountsResult, setAccountsResult] = useState(null) // {count, deleted} or {error}
  const [contactsResult, setContactsResult] = useState(null)

  const onConnect = () => {
    window.location.href = `/api/xero/connect?location_id=${location.id}`
  }

  const onDisconnect = async () => {
    if (!confirm(`Disconnect Xero from ${location.name}? Future invoice pushes will fail until you reconnect.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/xero/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      if (!j.success) alert(j.error || 'Disconnect failed')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const onSaveBillsEmail = async (e) => {
    e?.preventDefault?.()
    const trimmed = (billsEmail || '').trim()
    setSavingEmail(true); setEmailSaved(false)
    try {
      const res = await fetch('/api/xero/bills-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id, bills_email_address: trimmed || null }),
      })
      const j = await res.json()
      if (!j.success) {
        alert(j.error || 'Save failed')
        return
      }
      setEmailSaved(true)
      setTimeout(() => setEmailSaved(false), 1500)
      router.refresh()
    } finally {
      setSavingEmail(false)
    }
  }

  // XERO-API.1 — sync helpers. The API routes return the counts so
  // the user gets immediate feedback ("Synced 142 accounts, removed
  // 3 archived"). router.refresh() then re-fetches the connection
  // row so the timestamp + error fields re-flow into props.
  const onSyncAccounts = async () => {
    setSyncingAccounts(true)
    setAccountsResult(null)
    try {
      const res = await fetch(`/api/locations/${location.id}/xero/sync-accounts`, {
        method: 'POST',
      })
      const j = await res.json()
      if (!j.success) {
        setAccountsResult({ error: j.error || 'Sync failed' })
        return
      }
      setAccountsResult({ count: j.syncedCount, deleted: j.deletedCount })
      router.refresh()
    } catch (e) {
      setAccountsResult({ error: e.message || 'Network error' })
    } finally {
      setSyncingAccounts(false)
    }
  }

  const onSyncContacts = async () => {
    setSyncingContacts(true)
    setContactsResult(null)
    try {
      const res = await fetch(`/api/locations/${location.id}/xero/sync-contacts`, {
        method: 'POST',
      })
      const j = await res.json()
      if (!j.success) {
        setContactsResult({ error: j.error || 'Sync failed' })
        return
      }
      setContactsResult({ count: j.syncedCount, deleted: j.deletedCount, pages: j.pages })
      router.refresh()
    } catch (e) {
      setContactsResult({ error: e.message || 'Network error' })
    } finally {
      setSyncingContacts(false)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-un1t-white">{location.name}</div>
          {connection ? (
            <div className="text-xs text-un1t-light mt-1 space-y-0.5">
              <div>
                Connected to <span className="text-un1t-white">{connection.tenant_name || connection.tenant_id}</span>
              </div>
              <div className="text-un1t-mid">
                Linked {fmt(connection.connected_at)}
                {connection.last_refreshed_at && <> · refreshed {fmt(connection.last_refreshed_at)}</>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-un1t-light mt-1">Not connected.</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connection ? (
            <>
              <button
                onClick={onConnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-gray/40 hover:bg-un1t-gray text-un1t-white rounded-md disabled:opacity-50"
              >
                <RefreshCw size={12} /> Reconnect
              </button>
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-400 rounded-md disabled:opacity-50"
              >
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-white text-un1t-black rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              <Plug size={12} /> Connect Xero
            </button>
          )}
        </div>
      </div>

      {connection && (
        <div className="mt-4 pt-3 border-t border-un1t-gray/50">
          <label className="block text-xs uppercase tracking-wider text-un1t-light font-semibold mb-1">
            <Mail size={11} className="inline-block mr-1 mb-0.5" /> Email-to-Bills address
          </label>
          <p className="text-[11px] text-un1t-light mb-2">
            Find this in Xero under <strong>Business → Bills to pay → Create bill from email</strong>. Required for the &ldquo;Send to Xero&rdquo; button on supplier docs to work.
          </p>
          <form onSubmit={onSaveBillsEmail} className="flex items-center gap-2">
            <input
              type="email"
              value={billsEmail}
              onChange={e => setBillsEmail(e.target.value)}
              placeholder="bills+xxxxxxxxxx@xerofiles.com"
              className="flex-1 bg-un1t-black/30 border border-un1t-gray rounded-md px-3 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-light"
            />
            <button
              type="submit"
              disabled={savingEmail}
              className="text-xs px-3 py-1.5 bg-un1t-white text-un1t-black rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >
              {emailSaved ? <><Check size={12} /> Saved</> : (savingEmail ? 'Saving…' : 'Save')}
            </button>
          </form>
        </div>
      )}

      {connection && (
        <div className="mt-4 pt-3 border-t border-un1t-gray/50">
          <label className="block text-xs uppercase tracking-wider text-un1t-light font-semibold mb-1">
            <Database size={11} className="inline-block mr-1 mb-0.5" /> Xero data cache
          </label>
          <p className="text-[11px] text-un1t-light mb-2">
            The chart of accounts and contacts list are cached locally so the /invoices accountant
            review can suggest exact Xero accounts + suppliers without hammering the Xero API.
            Press refresh after adding a new contact or account in Xero.
          </p>

          {/* Two side-by-side panels — accounts on the left, contacts on the right. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {/* Accounts */}
            <div className="bg-un1t-black/30 border border-un1t-gray/50 rounded-md p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[11px] font-semibold text-un1t-white inline-flex items-center gap-1">
                  <Database size={11} /> Chart of accounts
                </div>
                <button
                  onClick={onSyncAccounts}
                  disabled={syncingAccounts}
                  className="text-[11px] px-2 py-1 bg-un1t-gray/40 hover:bg-un1t-gray text-un1t-white rounded inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw size={10} className={syncingAccounts ? 'animate-spin' : ''} />
                  {syncingAccounts ? 'Syncing…' : 'Refresh'}
                </button>
              </div>
              <div className="text-[10px] text-un1t-light">
                Last synced: <span className="text-un1t-white">{fmtRelative(connection.accounts_last_synced_at)}</span>
              </div>
              {accountsResult?.count !== undefined && (
                <div className="mt-1 text-[10px] text-emerald-400">
                  Synced {accountsResult.count} account{accountsResult.count === 1 ? '' : 's'}
                  {accountsResult.deleted > 0 ? ` (removed ${accountsResult.deleted} stale)` : ''}.
                </div>
              )}
              {accountsResult?.error && (
                <div className="mt-1 text-[10px] text-red-400">{accountsResult.error}</div>
              )}
              {!accountsResult && connection.accounts_sync_error && (
                <div className="mt-1 text-[10px] text-red-400">{connection.accounts_sync_error}</div>
              )}
            </div>

            {/* Contacts */}
            <div className="bg-un1t-black/30 border border-un1t-gray/50 rounded-md p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[11px] font-semibold text-un1t-white inline-flex items-center gap-1">
                  <Users size={11} /> Contacts (suppliers)
                </div>
                <button
                  onClick={onSyncContacts}
                  disabled={syncingContacts}
                  className="text-[11px] px-2 py-1 bg-un1t-gray/40 hover:bg-un1t-gray text-un1t-white rounded inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw size={10} className={syncingContacts ? 'animate-spin' : ''} />
                  {syncingContacts ? 'Syncing…' : 'Refresh'}
                </button>
              </div>
              <div className="text-[10px] text-un1t-light">
                Last synced: <span className="text-un1t-white">{fmtRelative(connection.contacts_last_synced_at)}</span>
              </div>
              {contactsResult?.count !== undefined && (
                <div className="mt-1 text-[10px] text-emerald-400">
                  Synced {contactsResult.count} contact{contactsResult.count === 1 ? '' : 's'}
                  {contactsResult.pages > 1 ? ` (${contactsResult.pages} pages)` : ''}
                  {contactsResult.deleted > 0 ? `, removed ${contactsResult.deleted} stale` : ''}.
                </div>
              )}
              {contactsResult?.error && (
                <div className="mt-1 text-[10px] text-red-400">{contactsResult.error}</div>
              )}
              {!contactsResult && connection.contacts_sync_error && (
                <div className="mt-1 text-[10px] text-red-400">{connection.contacts_sync_error}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
