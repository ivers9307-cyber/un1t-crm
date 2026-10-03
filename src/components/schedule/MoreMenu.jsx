// src/components/schedule/MoreMenu.jsx
'use client'

// ROSTERLOOK.1 — the roster toolbar's "More" menu.
//
// Eight buttons on two rows became one row by moving five secondary actions in
// here, which makes "every action stays reachable from the keyboard" THIS
// component's contract (WAI-ARIA menu button): focus moves into the menu on
// open, arrows move and wrap, Home/End jump, Escape closes and hands focus back
// to the button, Tab closes and moves on, a click outside closes.
//
// Choosing an item closes the menu and returns focus to the button BEFORE the
// action runs. Order matters: Copy last week opens a Modal, and the Modal
// primitive remembers document.activeElement as the place to return focus to.
// Run the action first and that element is a menu item that no longer exists.
//
// PLACEMENT. From `sm` up the menu hangs off the button's right edge. Below
// `sm` the wrapper is NOT the positioning context: the menu positions against
// the toolbar's actions group (which is `relative`) and spans its full width,
// because on a 390px phone the button can sit at either end of a wrapped row
// and a 220px menu anchored to it would leave the screen on one side or the
// other. jsdom cannot check any of this; the plan's browser task does.

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, MoreHorizontal } from 'lucide-react'

const ITEM_CLS =
  'w-full text-left px-3 py-2 text-xs text-un1t-text flex items-center gap-2 whitespace-nowrap ' +
  'hover:bg-un1t-border/40 focus-visible:outline-none focus-visible:bg-un1t-border/60 disabled:opacity-50 disabled:cursor-not-allowed'

export default function MoreMenu({ items, onSelect, label = 'More', active = false, icons = {} }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') || [])

  function close(returnFocus) {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  // Focus the first enabled item once the menu exists.
  useEffect(() => {
    if (open) enabledItems()[0]?.focus()
  }, [open])

  // A click anywhere else closes it. mousedown, so it closes before the click
  // lands on whatever the operator was reaching for.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onMenuKeyDown(e) {
    const list = enabledItems()
    const at = list.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'Tab') close(false)
    // A link answers Enter natively but not Space; a menu item answers both.
    else if (e.key === ' ' && document.activeElement?.tagName === 'A') { e.preventDefault(); document.activeElement.click() }
  }

  return (
    <div className="sm:relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? menuId : undefined}
        data-active={active ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
        }}
        className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent ${
          active
            ? 'bg-amber-500/20 border-amber-500/50 text-amber-700'
            : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30'
        }`}
      >
        <MoreHorizontal size={14} aria-hidden="true" /> {label}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More roster actions"
          onKeyDown={onMenuKeyDown}
          className="absolute z-30 top-full mt-1 left-0 right-0 sm:left-auto sm:right-0 sm:min-w-[220px] bg-un1t-bg border border-un1t-border rounded-lg shadow-lg py-1"
        >
          {items.map((item) => {
            const Icon = icons[item.key]
            const body = (
              <>
                {Icon && <Icon size={14} className="text-un1t-subtle shrink-0" aria-hidden="true" />}
                <span className="flex-1">{item.label}</span>
                {item.checked === true && <Check size={14} className="text-amber-700 shrink-0" aria-hidden="true" />}
              </>
            )
            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  title={item.title}
                  onClick={() => close(false)}
                  className={ITEM_CLS}
                >
                  {body}
                </Link>
              )
            }
            return (
              <button
                key={item.key}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked === undefined ? undefined : item.checked ? 'true' : 'false'}
                tabIndex={-1}
                disabled={!!item.disabled}
                title={item.title}
                onClick={() => { close(true); onSelect(item.key) }}
                className={ITEM_CLS}
              >
                {body}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
