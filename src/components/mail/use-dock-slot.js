'use client'

// MAIL-HOOKS.1 — the reader/compose mode slot machine, extracted from
// MailSurface. Two occupants (the reader card and the compose card), three
// shapes each (dock / full / min), ONE bottom-right slot between them — the
// coupling that used to be spread across MailSurface's verbs is internal
// here: restoring either occupant's card is what sends the other to its bar.
// The hook owns the mode STATE and the verbs; which occupant exists at all
// stays MailSurface's business (`hasReader` comes in as a prop, compose
// existence is `composeOpen` here because opening it is itself a slot move).

import { useEffect, useRef, useState } from 'react'
import {
  READER_MODE_MIN, DEFAULT_READER_MODE, readReaderMode, writeReaderMode,
  escTarget, restoreTarget,
  COMPOSE_MODE_MIN, DEFAULT_COMPOSE_MODE, readComposeMode, writeComposeMode,
  composeRestoreTarget, composeEscTarget,
  slotYieldTarget, isMdUp,
} from './mail-preferences'

export function useDockSlot({ hasReader }) {
  // ── MAIL-DOCK.1 — which shape the open conversation's card takes ─────
  //
  // 'dock' (the default), 'full' (the takeover) or 'min' (title bar only).
  // Hydrated from storage after mount exactly like density — and ONLY the
  // two persistable modes can come back from readReaderMode, so a reload
  // never opens minimised. `prevModeRef` is what a minimised card restores
  // to; it is a ref because it is a fact about the NEXT restore, not
  // something whose change should repaint anything now.
  const [readerMode, setReaderMode] = useState(DEFAULT_READER_MODE)
  const prevModeRef = useRef(DEFAULT_READER_MODE)

  // ── MAIL-DOCK.2 — the compose card's own mode, variant and slot ──────
  //
  // Same three shapes as the reader, its own key, hydrated in the same
  // mount effect below. `composeVariant` is which SHELL this compose session
  // uses — 'dock' (the md+ machinery) or 'modal' (below md, byte-for-byte
  // today's composer) — decided by isMdUp() AT OPEN and frozen for the life
  // of that compose, so a mid-draft window resize can never remount the form
  // and lose the words. `composePrevModeRef` mirrors prevModeRef: what the
  // minimised bar restores to.
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeMode, setComposeMode] = useState(DEFAULT_COMPOSE_MODE)
  const [composeVariant, setComposeVariant] = useState('modal')
  const composePrevModeRef = useRef(DEFAULT_COMPOSE_MODE)

  // Hydrate the two mode preferences AFTER mount, never during render — the
  // server has no localStorage, so reading them in the initial useState would
  // mismatch the server's own HTML. Once-only, and it lands before any
  // conversation can be open (a `?c=` deep link opens in the stored mode as
  // the contract asks) and before any compose can be open (opening takes a
  // click). Density hydrates in MailSurface's own mount effect — same
  // storage, same SSR reasoning, a separate concern.
  useEffect(() => {
    const stored = readReaderMode()
    setReaderMode(stored)
    prevModeRef.current = stored
    const storedCompose = readComposeMode()
    setComposeMode(storedCompose)
    composePrevModeRef.current = storedCompose
  }, [])

  // ⤢/⤡ — the operator's explicit choice, and the ONLY writes to storage:
  // Esc stepping full down to dock is a dismissal, not a preference, so it
  // changes the card without touching what next session opens with.
  function chooseReaderMode(next) {
    setReaderMode(next)
    writeReaderMode(next)
  }
  function minimiseReader() {
    prevModeRef.current = restoreTarget(readerMode)
    setReaderMode(READER_MODE_MIN)
  }
  function restoreReader() {
    // ONE SLOT — the reader's card coming back is what sends an open compose
    // card to its bar (the typed draft survives there, mounted).
    if (slotYieldTarget(composeOpen, composeMode)) minimiseCompose()
    setReaderMode(restoreTarget(prevModeRef.current))
  }
  // MAIL-DOCK.1 — `min` is a transient state of an OPEN card. A close (or a
  // deliberate open of the next conversation) must hand the mode back to the
  // real one underneath, or the next conversation would open as a bare title
  // bar nobody asked for. A no-op for any non-min mode.
  function unminimiseReader() {
    setReaderMode(m => (m === READER_MODE_MIN ? restoreTarget(prevModeRef.current) : m))
  }
  // The reader's Esc ladder step: full → dock, else "this key means close" —
  // the caller clears the selection on false. Stepping down from full
  // deliberately does NOT persist (see chooseReaderMode): Esc is how the
  // operator LEAVES, and it must not overwrite how they like to read.
  function readerEscStep() {
    const target = escTarget(readerMode)
    if (!target) return false
    setReaderMode(target)
    return true
  }
  // A list CLICK ends with the reader as a CARD either way, so an open
  // compose card yields the slot first (its typed draft survives in the
  // bar), and a minimised reader comes back to its real mode. j/k stay
  // bar-retargeting and never come through here.
  function claimReaderSlot() {
    if (slotYieldTarget(composeOpen, composeMode)) minimiseCompose()
    unminimiseReader()
  }

  function chooseComposeMode(next) {
    setComposeMode(next)
    writeComposeMode(next)
  }
  function minimiseCompose() {
    composePrevModeRef.current = composeRestoreTarget(composeMode)
    setComposeMode(COMPOSE_MODE_MIN)
  }
  function restoreCompose() {
    // The mirror of restoreReader's yield: compose taking the slot back
    // minimises the reader's card (its bar survives, the polls keep running).
    if (slotYieldTarget(hasReader, readerMode)) minimiseReader()
    setComposeMode(composeRestoreTarget(composePrevModeRef.current))
  }
  // `min` is a transient state of an OPEN compose. A close from it must hand
  // the NEXT open back to the real mode underneath — clearSelection's rule,
  // applied to the second occupant of the slot.
  function closeCompose() {
    setComposeOpen(false)
    setComposeMode(m => (m === COMPOSE_MODE_MIN ? composeRestoreTarget(composePrevModeRef.current) : m))
  }
  // The compose Esc ladder — dirty-aware, routed from ComposeDock's scoped
  // keydown. `dirty` and `requestClose` are TicketCompose's own (the shell
  // hands them through), so "pristine closes silently" and "✕ confirms" are
  // the same code paths the Modal always had.
  function handleComposeEscape(dirty, requestClose) {
    const target = composeEscTarget(composeMode, dirty)
    if (target === null) { requestClose(); return }
    if (target === composeMode) return // the bar is the floor for a dirty draft
    if (target === COMPOSE_MODE_MIN) minimiseCompose()
    else setComposeMode(target) // full → dock: a dismissal, never persisted
  }
  // MAIL-DOCK.2 — the slot half of every compose entry. The shell variant is
  // decided NOW and frozen for this compose session (see composeVariant's
  // comment); a dock-variant open is also the moment the reader's card
  // yields the bottom-right slot — auto-minimised, bar surviving, polls
  // running. The Modal variant overlays everything and takes no slot.
  // Belt and braces on the mode reset — closeCompose already resets a
  // leftover min, but a compose must never OPEN as a bare title bar.
  function openComposeSlot() {
    const dockVariant = isMdUp()
    setComposeVariant(dockVariant ? 'dock' : 'modal')
    if (dockVariant && slotYieldTarget(hasReader, readerMode)) minimiseReader()
    setComposeMode(m => (m === COMPOSE_MODE_MIN ? composeRestoreTarget(composePrevModeRef.current) : m))
    setComposeOpen(true)
  }

  return {
    readerMode,
    chooseReaderMode,
    minimiseReader,
    restoreReader,
    unminimiseReader,
    readerEscStep,
    claimReaderSlot,
    composeOpen,
    composeMode,
    composeVariant,
    chooseComposeMode,
    minimiseCompose,
    restoreCompose,
    closeCompose,
    handleComposeEscape,
    openComposeSlot,
  }
}
