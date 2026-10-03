'use client'

// ICSFEED.1 — /account: subscribe to your own published shifts.
//
// The link is shown ONCE, right after it is made (only its hash is stored,
// mig 632). Afterwards the card can say the link is on and when a calendar
// last fetched it, and offer a new link (the old one stops) or turning it off.
// Every URL comes from the server (calendarFeedUrls); nothing is built here.

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui'

const ENDPOINT = '/api/me/calendar-feed'

function dublinStamp(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function CalendarFeedCard() {
  const [status, setStatus] = useState(null) // null while loading
  const [links, setLinks] = useState(null)   // { url, webcal_url, google_url } — only right after POST
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' })
      const body = await res.json()
      if (body.success) setStatus(body.data)
      else setError(body.error || 'Could not load your calendar link.')
    } catch {
      setError('Could not load your calendar link.')
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function issue(replace) {
    if (replace && !window.confirm('Make a new link? Calendars using your current link will stop updating.')) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replace }),
      })
      const body = await res.json()
      if (!body.success) {
        setError(body.error || 'Could not make your calendar link.')
        if (res.status === 409) await load()
        return
      }
      setLinks(body.data)
      await load()
    } catch {
      setError('Could not make your calendar link.')
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    if (!window.confirm('Turn off your calendar link? Your calendar will stop getting your shifts.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(ENDPOINT, { method: 'DELETE' })
      const body = await res.json()
      if (!body.success) {
        setError(body.error || 'Could not turn off your calendar link.')
        return
      }
      setLinks(null)
      await load()
    } catch {
      setError('Could not turn off your calendar link.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(links.url)
      setCopied(true)
    } catch {
      setError('Copy failed. Select the link and copy it yourself.')
    }
  }

  const lastChecked = dublinStamp(status?.last_fetched_at)

  return (
    <div className="border-t border-un1t-border pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Calendar</h2>
      <div className="p-4 rounded-xl bg-un1t-surface border border-un1t-border">
        <div className="flex items-start gap-3">
          <CalendarDays size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-un1t-text">Subscribe to my shifts</div>
            <p className="text-xs text-un1t-subtle mt-1">
              Your published shifts at every studio, in Apple, Google or Outlook Calendar: two weeks back and
              eight weeks ahead. Your calendar app checks for changes on its own schedule (Google can take several
              hours). The link stops working if your account is deactivated.
            </p>

            {status?.active && (
              <p className="text-xs text-un1t-text mt-2">
                Your calendar link is on.{' '}
                {lastChecked
                  ? `Last checked by your calendar ${lastChecked}.`
                  : 'Your calendar has not checked it yet.'}
              </p>
            )}

            {links && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-un1t-text">
                  This link is shown once. Anyone who has it can see your shifts, so keep it to yourself.
                  If you shared it by mistake, make a new link.
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={links.url}
                    aria-label="Calendar link"
                    onFocus={(e) => e.target.select()}
                    className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-lg border border-un1t-border bg-un1t-bg text-un1t-text"
                  />
                  <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <a href={links.webcal_url} className="text-un1t-text underline">Open in Apple Calendar or Outlook</a>
                  <a href={links.google_url} target="_blank" rel="noopener noreferrer" className="text-un1t-text underline">
                    Add to Google Calendar
                  </a>
                </div>
              </div>
            )}

            {error && <p role="alert" className="text-xs text-red-700 mt-2">{error}</p>}

            <div className="flex flex-wrap gap-2 mt-3">
              {status && !status.active && (
                <Button size="sm" loading={busy} onClick={() => issue(false)}>Get my calendar link</Button>
              )}
              {status?.active && (
                <>
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => issue(true)}>Make a new link</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>Turn off</Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
