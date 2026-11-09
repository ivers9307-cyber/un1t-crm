'use client'
// HOSTTHEME.1 — the light/dark switch in the host portal header (and on the
// login pages). A click writes the one-year `host_theme` cookie and flips
// data-host-theme on the nearest themed wrapper at once, no reload.

import { useEffect, useRef, useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { hostThemeCookieString } from '@/lib/host-theme'

function deviceTheme() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export default function HostThemeToggle({ initial }) {
  // 'system' shows dark until mounted (the CSS default), then the device's choice.
  const [theme, setTheme] = useState(initial === 'light' || initial === 'dark' ? initial : 'dark')
  const root = useRef(null)

  useEffect(() => {
    if (initial !== 'light' && initial !== 'dark') setTheme(deviceTheme())
  }, [initial])

  function choose(next) {
    document.cookie = hostThemeCookieString(next)
    root.current?.closest('[data-host-theme]')?.setAttribute('data-host-theme', next)
    setTheme(next)
  }

  const base = 'inline-flex h-8 w-8 items-center justify-center rounded-md'
  const on = 'bg-host-accent text-host-on-accent'
  const off = 'text-host-hint hover:bg-host-well hover:text-host-text'
  return (
    <div ref={root} className="inline-flex items-center gap-0.5 rounded-lg border border-host-edge bg-host-panel p-0.5">
      <button
        type="button"
        aria-label="Use the light theme"
        aria-pressed={theme === 'light'}
        onClick={() => choose('light')}
        className={`${base} ${theme === 'light' ? on : off}`}
      >
        <Sun className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Use the dark theme"
        aria-pressed={theme === 'dark'}
        onClick={() => choose('dark')}
        className={`${base} ${theme === 'dark' ? on : off}`}
      >
        <Moon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
