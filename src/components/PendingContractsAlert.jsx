'use client'

// Two-stage alert for unsigned contracts:
//   1. On first authenticated page-load each session, fetch the
//      caller's pending contracts. If any, show a centred modal
//      with a list + "Sign now" / "Remind me later".
//   2. If the user dismisses the modal (X or Remind me later),
//      it's gone for the rest of the session — replaced by a
//      compact yellow banner pinned at the top of every page
//      until they actually sign one. Banner persists across
//      navigations because the parent AppShell re-mounts this
//      component on every page.
//
// We don't show this on /login or other public paths — AppShell
// short-circuits for `publicPaths` so this is only ever mounted
// for an authenticated session.
//
// "Dismissed" state lives in sessionStorage (per-tab, per-browser-
// session). Rationale: a hard refresh shouldn't re-show the modal,
// but closing and re-opening the browser should — the contract is
// important, the nag is intentional.
//
// We hide the alert entirely on /account/contracts and any
// /account/contracts/* page — the user is already there, the
// banner would just shout at them about something they're
// looking at.

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { FileSignature, X, ChevronRight } from 'lucide-react'

const DISMISS_KEY = 'un1t_contracts_modal_dismissed_v1'

function shouldHideOn(pathname) {
  if (!pathname) return false
  return pathname.startsWith('/account/contracts')
}

export default function PendingContractsAlert() {
  const pathname = usePathname()
  const [pending, setPending] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  // Read sessionStorage during render so the modal doesn't flash
  // open then immediately close on remount.
  const wasDismissed = typeof window !== 'undefined' && window.sessionStorage?.getItem(DISMISS_KEY) === '1'

  useEffect(() => {
    let alive = true
    fetch('/api/account/pending-contracts')
      .then(r => r.json())
      .then(json => {
        if (!alive) return
        const list = json?.data || []
        setPending(list)
        setLoaded(true)
        if (list.length > 0 && !wasDismissed) {
          setModalOpen(true)
        }
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => { alive = false }
    // We deliberately re-run on pathname change so signing a
    // contract (which navigates) refetches and clears the alert.
  }, [pathname, wasDismissed])

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Some private-browsing modes block storage — banner still
      // works visually because we control state in React; the only
      // downside is the modal might reappear on refresh in those
      // modes. Acceptable.
    }
    setModalOpen(false)
  }

  if (!loaded) return null
  if (pending.length === 0) return null
  if (shouldHideOn(pathname)) return null

  // Most recent pending contract — the modal CTA + banner CTA both
  // jump straight to it. Saves a click vs. landing on the list.
  const top = pending[0]
  const signHref = `/account/contracts/${top.id}`
  const count = pending.length

  return (
    <>
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-un1t-surface border border-un1t-border rounded-2xl max-w-md w-full p-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <FileSignature size={20} className="text-amber-700" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-un1t-text">
                  {count === 1
                    ? 'You have a contract awaiting signature'
                    : `You have ${count} contracts awaiting signature`}
                </h2>
                <p className="text-xs text-un1t-subtle mt-1">
                  {count === 1
                    ? 'UN1T Dublin needs your signature on this document.'
                    : 'UN1T Dublin needs your signature on these documents.'}
                </p>
              </div>
              <button
                onClick={dismiss}
                aria-label="Dismiss"
                className="text-un1t-subtle hover:text-un1t-text -mt-1 -mr-1 p-1"
              >
                <X size={16} />
              </button>
            </div>

            <ul className="mt-4 space-y-1.5">
              {pending.slice(0, 5).map(c => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-un1t-border/40"
                >
                  <span className="text-sm text-un1t-text truncate">{c.template_name}</span>
                  <Link
                    href={`/account/contracts/${c.id}`}
                    onClick={() => setModalOpen(false)}
                    className="text-xs text-amber-700 hover:text-amber-800 inline-flex items-center shrink-0"
                  >
                    Open <ChevronRight size={12} />
                  </Link>
                </li>
              ))}
              {count > 5 && (
                <li className="px-3 py-1 text-[11px] text-un1t-subtle italic">
                  +{count - 5} more in your account.
                </li>
              )}
            </ul>

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={dismiss}
                className="text-xs px-3 py-1.5 rounded-md text-un1t-subtle hover:text-un1t-text"
              >
                Remind me later
              </button>
              <Link
                href={signHref}
                onClick={() => setModalOpen(false)}
                className="text-xs bg-un1t-text text-un1t-bg px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent inline-flex items-center gap-1.5"
              >
                <FileSignature size={11} /> Sign now
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Banner — only when modal is closed (either dismissed this
          session OR clicked-through and bounced back). Pinned at
          the top of the main content area, full width, dismissible
          per-pageload but reappears on next nav since pending is
          still > 0. */}
      {!modalOpen && (
        <div className="bg-amber-500 text-black px-4 py-2 text-xs flex items-center gap-3">
          <FileSignature size={14} />
          <span className="flex-1 min-w-0 truncate">
            {count === 1
              ? 'You have a contract awaiting your signature.'
              : `You have ${count} contracts awaiting your signature.`}
          </span>
          <Link
            href={signHref}
            className="bg-black text-white px-3 py-1 rounded-md font-semibold whitespace-nowrap hover:opacity-90"
          >
            Sign now
          </Link>
        </div>
      )}
    </>
  )
}
