'use client'

// The Xero connection card on the per-location Integrations tab
// (/settings/locations/[id]?tab=xero). Shows the current
// connection state and offers a Connect / Disconnect / Reconnect
// action depending on the row's state. Also captures the per-org
// Xero "Email to Bills" address so the document → draft bill
// auto-forward has somewhere to send to.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink, Database, Users, Check } from 'lucide-react'

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

  // XERO-ONE-ORG.1 — one location, one Xero organisation. The OAuth callback
  // has to store SOME org before anyone can see what it picked, so this is how
  // a wrong binding gets corrected: the stored token already grants every org
  // the login authorised, so switching needs no new consent.
  const [orgs, setOrgs] = useState(null)
  const [orgBusy, setOrgBusy] = useState(false)
  const [orgError, setOrgError] = useState(null)

  const loadOrgs = async () => {
    setOrgBusy(true); setOrgError(null)
    try {
      const res = await fetch(`/api/xero/select-tenant?location_id=${location.id}`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Could not list organisations')
      setOrgs(j.data)
    } catch (e) { setOrgError(e.message) } finally { setOrgBusy(false) }
  }

  const switchOrg = async (tenantId, tenantName) => {
    if (!confirm(`Point ${location.name} at "${tenantName}"?\n\nFuture bills will be filed there. Cached accounts, tax rates and contacts are cleared and re-synced from the new organisation. Bills already sent are NOT moved.`)) return
    setOrgBusy(true); setOrgError(null)
    try {
      const res = await fetch('/api/xero/select-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id, tenant_id: tenantId }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Switch failed')
      window.location.reload()
    } catch (e) { setOrgError(e.message); setOrgBusy(false) }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-un1t-text">{location.name}</div>
          {connection ? (
            <div className="text-xs text-un1t-subtle mt-1 space-y-0.5">
              <div>
                Connected to <span className="text-un1t-text">{connection.tenant_name || connection.tenant_id}</span>
              </div>
              <div className="text-un1t-muted">
                Linked {fmt(connection.connected_at)}
                {connection.last_refreshed_at && <> · refreshed {fmt(connection.last_refreshed_at)}</>}
              </div>
              <div className="pt-1">
                {orgs === null ? (
                  <button
                    type="button"
                    onClick={loadOrgs}
                    disabled={orgBusy}
                    className="text-un1t-subtle underline hover:text-un1t-text disabled:opacity-50"
                  >
                    {orgBusy ? 'Checking…' : 'Change organisation'}
                  </button>
                ) : (
                  <div className="mt-1 space-y-1">
                    {orgs.available.filter((o) => o.tenant_id !== orgs.current_tenant_id).map((o) => (
                      <button
                        type="button"
                        key={o.tenant_id}
                        onClick={() => switchOrg(o.tenant_id, o.tenant_name)}
                        disabled={orgBusy}
                        className="block text-un1t-text underline hover:no-underline disabled:opacity-50"
                      >
                        Use “{o.tenant_name || o.tenant_id}”
                      </button>
                    ))}
                    {orgs.unavailable.map((o) => (
                      <div key={o.tenant_id} className="text-un1t-muted">
                        “{o.tenant_name || o.tenant_id}” — already used by {o.claimed_by}
                      </div>
                    ))}
                    {!orgs.available.filter((o) => o.tenant_id !== orgs.current_tenant_id).length && (
                      <div className="text-un1t-muted">No other organisation is free for this location.</div>
                    )}
                  </div>
                )}
                {orgError && <div className="text-red-700 mt-1">{orgError}</div>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-un1t-subtle mt-1">Not connected.</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connection ? (
            <>
              <button
                onClick={onConnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50"
              >
                <RefreshCw size={12} /> Reconnect
              </button>
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-700 rounded-md disabled:opacity-50"
              >
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              <Plug size={12} /> Connect Xero
            </button>
          )}
        </div>
      </div>

      {/* XERO-API.3 — the Email-to-Bills input was removed when the
          /invoices send path switched from Postmark → Hubdoc to a
          direct /Invoices API push. The bills_email_address column
          is kept nullable on xero_connections for rollback safety
          (see mig 187 header); no UI surface for it anymore. */}

      {connection && (
        <div className="mt-4 pt-3 border-t border-un1t-border/50">
          <label className="block text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1">
            <Database size={11} className="inline-block mr-1 mb-0.5" /> Xero data cache
          </label>
          <p className="text-[11px] text-un1t-subtle mb-2">
            The chart of accounts, tax rates and contacts list are cached locally so the /invoices
            accountant review can suggest exact Xero accounts, VAT rates + suppliers without hammering
            the Xero API. Press refresh after adding a new contact, account or tax rate in Xero.
          </p>

          {/* Two side-by-side panels — accounts on the left, contacts on the right. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {/* Accounts */}
            <div className="bg-un1t-bg/30 border border-un1t-border/50 rounded-md p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[11px] font-semibold text-un1t-text inline-flex items-center gap-1">
                  <Database size={11} /> Chart of accounts &amp; tax rates
                </div>
                <button
                  onClick={onSyncAccounts}
                  disabled={syncingAccounts}
                  className="text-[11px] px-2 py-1 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw size={10} className={syncingAccounts ? 'animate-spin' : ''} />
                  {syncingAccounts ? 'Syncing…' : 'Refresh'}
                </button>
              </div>
              <div className="text-[10px] text-un1t-subtle">
                Accounts last synced: <span className="text-un1t-text">{fmtRelative(connection.accounts_last_synced_at)}</span>
              </div>
              {/* XERO-BILL-VAT.2 — the Refresh above now also syncs the
                  location's Xero tax rates (same tenant, same cadence),
                  so surface their freshness beside the accounts line. */}
              <div className="text-[10px] text-un1t-subtle">
                Tax rates last synced: <span className="text-un1t-text">{fmtRelative(connection.tax_rates_last_synced_at)}</span>
              </div>
              {!accountsResult && connection.tax_rates_sync_error && (
                <div className="mt-1 text-[10px] text-red-400">Tax rates: {connection.tax_rates_sync_error}</div>
              )}
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
            <div className="bg-un1t-bg/30 border border-un1t-border/50 rounded-md p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[11px] font-semibold text-un1t-text inline-flex items-center gap-1">
                  <Users size={11} /> Contacts (suppliers)
                </div>
                <button
                  onClick={onSyncContacts}
                  disabled={syncingContacts}
                  className="text-[11px] px-2 py-1 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw size={10} className={syncingContacts ? 'animate-spin' : ''} />
                  {syncingContacts ? 'Syncing…' : 'Refresh'}
                </button>
              </div>
              <div className="text-[10px] text-un1t-subtle">
                Last synced: <span className="text-un1t-text">{fmtRelative(connection.contacts_last_synced_at)}</span>
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

      {/* CAR-SALES-ACCOUNT.1 — per-location car-sales account code.
          Surfaces the connected tenant's chart of accounts (from
          the xero_accounts cache) so the operator picks the right
          REVENUE/SALES account for car-invoice pushes. */}
      {connection && (
        <CarSalesAccountSection location={location} connection={connection} />
      )}
    </div>
  )
}

// CAR-SALES-ACCOUNT.1 — picker for the per-location car-invoice
// sales account. Reads options from the cached xero_accounts via
// /api/locations/[id]/xero/accounts?type=ALL and filters client-
// side to REVENUE + SALES + ACTIVE. Saves via POST
// /api/locations/[id]/xero/car-sales-account.
function CarSalesAccountSection({ location, connection }) {
  const router = useRouter()
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false)
  const [picked, setPicked] = useState(connection?.car_sales_account_code || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/locations/${location.id}/xero/accounts?type=ALL`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load accounts')
          return
        }
        // Filter client-side: REVENUE or SALES account types that
        // are ACTIVE. Status filter is already applied server-side.
        const filtered = (j.accounts || []).filter((a) =>
          a.account_type === 'REVENUE' || a.account_type === 'SALES'
        )
        setAccounts(filtered)
        setStale(!!j.stale)
      })
      .catch((e) => !cancelled && setError(e.message || 'Network error'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [location.id])

  async function onSave(e) {
    e?.preventDefault?.()
    setSaving(true); setSaved(false)
    try {
      const res = await fetch(`/api/locations/${location.id}/xero/car-sales-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_code: picked || null }),
      })
      const j = await res.json()
      if (!j.success) { alert(j.error || 'Save failed'); return }
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 pt-3 border-t border-un1t-border/50">
      <label className="block text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1">
        Car-invoice sales account
      </label>
      <p className="text-[11px] text-un1t-subtle mb-2">
        Used when issuing a car invoice from car processing → push to Xero. Pick the REVENUE/SALES
        account this location books car sales against. Sourced from the cached chart of accounts —
        if a new one is missing, hit <strong>Refresh</strong> on the chart-of-accounts panel above.
      </p>
      <form onSubmit={onSave} className="flex items-center gap-2">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={loading || saving || accounts.length === 0}
          className="flex-1 bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-xs text-un1t-text focus:outline-none focus:border-un1t-subtle disabled:opacity-50"
        >
          <option value="">{loading ? 'Loading…' : (accounts.length === 0 ? 'No REVENUE/SALES accounts cached — refresh above' : '— Use default (env or 200) —')}</option>
          {accounts.map((a) => (
            <option key={a.xero_account_id} value={a.code || ''}>
              {a.code ? `${a.code} — ` : ''}{a.name}{a.account_type === 'SALES' ? ' (sales)' : ''}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={saving || loading}
          className="text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
        >
          {saved ? <><Check size={12} /> Saved</> : (saving ? 'Saving…' : 'Save')}
        </button>
      </form>
      {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
      {stale && !error && accounts.length > 0 && (
        <div className="mt-1 text-[10px] text-amber-400">
          Chart of accounts cache is older than 30 days. Hit Refresh above to make sure your
          options are current.
        </div>
      )}
    </div>
  )
}
