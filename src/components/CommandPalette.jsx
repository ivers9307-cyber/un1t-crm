'use client'

// CMD-K.1 — global command palette. ⌘K / Ctrl-K anywhere opens a
// search-and-jump modal: find any contact, navigate to any permitted
// destination, or quick-create. Mounted once in AppShell so it's
// available on every authed page. Pure logic + the command lists live
// in @/lib/command-palette (unit-tested); this shell is the keyboard +
// DOM + data-fetch wiring.

import { useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { Search, User, ArrowRight, Plus } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import {
  NAV_COMMANDS,
  CREATE_COMMANDS,
  visibleCommands,
  sanitizeSearchTerm,
  MIN_CONTACT_SEARCH_LEN,
} from '@/lib/command-palette'

export default function CommandPalette({ user }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState([])
  const [searching, setSearching] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)

  const locId = user?.activeLocation?.id
  const hasPerm = (key) => hasPermission(user, key)

  // Global ⌘K / Ctrl-K toggle. Registered once; preventDefault so the
  // browser's own ⌘K (address-bar search in some browsers) doesn't fire.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus the input + reset transient state whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setContacts([])
      setActiveIndex(0)
      // focus after paint so the element exists
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  // Reset the highlighted row whenever the query changes.
  useEffect(() => { setActiveIndex(0) }, [query])

  // Debounced contact search (browser Supabase client — RLS scopes the
  // read to the caller's locations; we narrow to the active location).
  useEffect(() => {
    if (!open) return
    const term = sanitizeSearchTerm(query)
    if (term.length < MIN_CONTACT_SEARCH_LEN || !locId) { setContacts([]); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const db = createBrowserClient()
        const { data } = await db
          .from('contacts')
          .select('id, name, email, phone')
          .eq('location_id', locId)
          // CONTACT-DEDUP — jump straight to the one unified profile per
          // person; the non-primary linked accounts route to it anyway.
          .eq('is_primary_contact', true)
          .or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
          .limit(6)
        if (!cancelled) setContacts(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setContacts([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 180)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query, open, locId])

  if (!open) return null

  // Build the combined, ordered result list. Create + nav are permission
  // + query filtered via the pure helper; contacts come from the search.
  const createResults = visibleCommands(CREATE_COMMANDS, query, hasPerm)
  const navResults = visibleCommands(NAV_COMMANDS, query, hasPerm)
  const results = [
    ...createResults.map((c) => ({ key: `create:${c.id}`, type: 'create', label: c.label, href: c.href })),
    ...navResults.map((c) => ({ key: `nav:${c.id}`, type: 'go', label: c.label, href: c.href })),
    ...contacts.map((c) => ({
      key: `contact:${c.id}`,
      type: 'contact',
      label: c.name || c.email || 'Contact',
      sublabel: c.email || c.phone || '',
      href: `/contacts/${c.id}`,
    })),
  ]

  function close() { setOpen(false) }

  function exec(item) {
    if (!item) return
    close()
    router.push(item.href)
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      exec(results[activeIndex])
    }
  }

  const ICONS = { contact: User, go: ArrowRight, create: Plus }
  const TYPE_LABEL = { contact: 'Contact', go: 'Go to', create: 'Create' }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center pt-[12vh] px-4"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg bg-un1t-surface border border-un1t-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-un1t-border">
          <Search size={16} className="text-un1t-subtle shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search contacts, jump to a page, create…"
            className="flex-1 bg-transparent py-3 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none"
          />
          <kbd className="hidden sm:inline text-[10px] text-un1t-muted border border-un1t-border rounded px-1.5 py-0.5 shrink-0">esc</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-un1t-subtle">
              {searching ? 'Searching…' : 'No matches'}
            </div>
          ) : (
            results.map((r, i) => {
              const Icon = ICONS[r.type] || ArrowRight
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => exec(r)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full text-left px-4 py-2 flex items-center gap-3 ${i === activeIndex ? 'bg-un1t-border/40' : ''}`}
                >
                  <Icon size={15} className="text-un1t-subtle shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-un1t-text truncate">{r.label}</span>
                    {r.sublabel ? (
                      <span className="block text-xs text-un1t-subtle truncate">{r.sublabel}</span>
                    ) : null}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-un1t-muted shrink-0">
                    {TYPE_LABEL[r.type]}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
