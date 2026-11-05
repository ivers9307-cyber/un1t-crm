'use client'

// RADAR-AGENT.0 — operator settings for the customer-facing WhatsApp /
// Instagram agent. Manager+ only. Ships OFF by default.
//
// MIASETTINGS.2c — the shell: a header (title, studio, the SAVED status and
// quiet hours), a section menu, and one section at a time. Every section
// stays mounted and the others get `hidden`, so a draft survives a switch
// (offers, voices and knowledge drafts too). The open section is in the URL
// (`?section=<key>`, sections.js), read once on mount and written with
// history.replaceState. The header, the menu and its links sit outside the
// disabled <fieldset>s, so a read-only viewer can still move around; each
// section puts its settings in its own fieldset. The studio settings state
// lives in useAgentSettings; one Save saves edits made in every section.
//
// MIAROLE.1 (C80) — `canEdit` comes from the server page (canEditMiaSettings:
// owner at the active studio, or master), the same predicate the PUT gates
// on. Omitted, it fails closed: the settings render read-only, with no Save.
// The knowledge editor is outside that rule; Mia's voices carry their own
// (`canEditVoices`, owners and managers: VOICEREPLY.1).
// MIAORG.1 Task 4 — `orgDefaults` ({ organizationId, organizationName }) is
// set by the server page only for a master or an admin of the organisation
// (resolveAdminOrgId).
// MIASETTINGS.4 — for them the header has a scope switch, "This studio" or
// "All studios (organisation)" (`?scope=org`). In the organisation scope the
// menu lists only the sections the organisation can set, and
// OrgDefaultsClient draws that section's organisation fields with its own
// save bar; the studio sections and their bar stay mounted, hidden. Both
// scopes stay mounted, so a draft survives a section switch either way.
// Switching scope while the scope you are in has unsaved changes asks
// "Discard your unsaved changes?" first: No stays, Yes drops them and
// switches.

import { useEffect, useRef, useState } from 'react'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
import { hubManageHref } from '@/lib/integrations-hub-links'
import OrgDefaultsClient from './OrgDefaultsClient'
import { useAgentSettings } from './useAgentSettings'
import { SECTIONS, parseLocation, writeLocation } from './sections'
import { statusOf } from './status'
import { fieldsFor } from './fields'
import SectionMenu from './components/SectionMenu'
import SaveBar from './components/SaveBar'
import { changedFieldCount } from './dirty'
import { fieldRenderer } from './sections/field-renderer'
import OverviewSection from './sections/OverviewSection'
import PersonalitySection from './sections/PersonalitySection'
import HandoffsSection from './sections/HandoffsSection'
import BookingsSection from './sections/BookingsSection'
import MessagesSection from './sections/MessagesSection'
import FollowupsSection from './sections/FollowupsSection'
import CancellationSection from './sections/CancellationSection'
import KnowledgeSection from './sections/KnowledgeSection'
import MemberAppSection from './sections/MemberAppSection'

const SECTION_COMPONENTS = {
  overview: OverviewSection,
  personality: PersonalitySection,
  handoffs: HandoffsSection,
  bookings: BookingsSection,
  messages: MessagesSection,
  followups: FollowupsSection,
  cancellation: CancellationSection,
  knowledge: KnowledgeSection,
  'member-app': MemberAppSection,
}

const CHIP = 'text-xs rounded-full px-2 py-0.5 whitespace-nowrap'
const STATUS_CHIPS = {
  off: { text: 'Off', cls: 'border border-un1t-border text-un1t-muted' },
  test: { text: 'Test', cls: 'bg-amber-500/10 text-amber-700' },
  live: { text: 'Live', cls: 'bg-green-500/10 text-green-700' },
  // Live and Test both on is live for everyone: it reads as Live.
  live_and_test: { text: 'Live', cls: 'bg-green-500/10 text-green-700' },
}

// The section and scope the page opens on: the URL's, made safe
// (sections.js): the organisation scope only for someone the server passed
// orgDefaults, and only a section that scope has.
function initialLocation(canOrg) {
  if (typeof window === 'undefined') return { section: 'overview', scope: 'studio' }
  return parseLocation(window.location.search, { canOrg })
}

const ORG_SECTIONS = SECTIONS.filter((s) => s.scopes.includes('org'))
const ORG_MESSAGE_COUNT = fieldsFor('org', 'messages').length
const SCOPES = [['studio', 'This studio'], ['org', 'All studios (organisation)']]
const NO_SECTIONS = new Set()

export default function CustomerAgentClient({ canEdit = false, orgDefaults = null, canEditVoices = false } = {}) {
  const agent = useAgentSettings({ canEdit })
  const { loading, loadFailed, reload, settings, saved, location, holds, saving, savedAt, error, save, discard, refreshInherited, dirtyPaths, dirtySections } = agent
  const canOrg = !!orgDefaults?.organizationId
  const [{ section, scope }, setPlace] = useState(() => initialLocation(canOrg))
  // MIASETTINGS.3c — the Knowledge entries are loaded by its section; it reports the total here for the menu.
  const [knowledgeCount, setKnowledgeCount] = useState(null)
  // MIASETTINGS.4 — the organisation editor's unsaved changes (its own state).
  const [orgDirty, setOrgDirty] = useState({ count: 0, sections: NO_SECTIONS })
  const orgRef = useRef(null)

  // Leaving the page (close, reload, a typed address) with unsaved changes.
  const isDirty = dirtyPaths.length > 0
  const anyDirty = isDirty || orgDirty.count > 0
  useEffect(() => {
    if (!anyDirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])

  function openSection(key) {
    setPlace({ section: key, scope })
    writeLocation({ section: key, scope })
  }

  // Switching scope: the scope you leave keeps no unsaved change unless you
  // say so (a No stays put). A section the new scope lacks opens Overview.
  function switchScope(next) {
    if (next === scope) return
    const leavingDirty = scope === 'org' ? orgDirty.count > 0 : isDirty
    if (leavingDirty) {
      if (!window.confirm('Discard your unsaved changes?')) return
      if (scope === 'org') orgRef.current?.discard()
      else discard()
    }
    const has = SECTIONS.find((s) => s.key === section)?.scopes.includes(next)
    const place = { section: has ? section : 'overview', scope: next }
    setPlace(place)
    writeLocation(place)
  }
  function onOrgDirtyChange(count, sections) {
    setOrgDirty({ count, sections })
  }

  if (loading) return <div className="p-6 text-sm text-un1t-muted">Loading…</div>
  if (loadFailed || !settings) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-xl font-bold text-un1t-text mb-4">Customer Agent</h1>
        <ReadFailedNote what="the customer agent settings" onRetry={() => reload()} />
      </div>
    )
  }

  const renderField = fieldRenderer(agent)
  const inOrg = scope === 'org'
  const menuCounts = inOrg ? { messages: ORG_MESSAGE_COUNT } : {
    messages: fieldsFor('studio', 'messages', agent.ctx).length,
    ...(knowledgeCount == null ? {} : { knowledge: knowledgeCount }),
  }
  const firstFieldError = Object.values(agent.serverFieldErrors || {}).find((m) => typeof m === 'string' && m)
  const status = STATUS_CHIPS[statusOf(saved || settings)]
  const quiet = saved?.quiet_hours
  const quietChip = quiet && !quiet.off && quiet.start && quiet.end ? `Quiet ${quiet.start} to ${quiet.end}` : null
  const readOnlyNote = (
    <p className="text-sm text-un1t-muted border border-un1t-border rounded-lg px-4 py-3 mb-6">
      Only an owner can change Mia&apos;s settings here.
    </p>
  )
  const links = [
    { href: '/settings/customer-agent/analytics', label: 'Activity' },
    { href: '/settings/customer-agent/requests', label: 'Requests' },
    // IG-HOME.1 / INTEGONE.1 — channel connections live in the Integrations
    // hub; this opens its Instagram drawer for this studio.
    ...(location?.id ? [{ href: hubManageHref(location.id, 'instagram'), label: 'Channel connections' }] : []),
  ]

  return (
    <div className="max-w-5xl">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold text-un1t-text">Customer Agent</h1>
          {location?.name && <span className="text-sm text-un1t-muted">{location.name}</span>}
          {!inOrg && <span className={`${CHIP} ${status.cls}`}>{status.text}</span>}
          {!inOrg && quietChip && <span className={`${CHIP} border border-un1t-border text-un1t-muted`}>{quietChip}</span>}
        </div>
        {canOrg && (
          <div role="radiogroup" aria-label="Editing" className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-sm text-un1t-muted" aria-hidden="true">Editing:</span>
            {SCOPES.map(([key, text]) => {
              const on = scope === key
              return (
                <button key={key} type="button" role="radio" aria-checked={on} onClick={() => switchScope(key)}
                  className={`text-sm rounded-md px-3 py-1 border ${on
                    ? 'bg-un1t-surface border-un1t-border font-medium text-un1t-text'
                    : 'border-transparent text-un1t-muted hover:text-un1t-text'}`}>
                  {text}
                </button>
              )
            })}
          </div>
        )}
        <p className="text-sm text-un1t-muted mt-1">
          The AI assistant that answers customers on WhatsApp and Instagram. It answers only from its
          knowledge and hands anything else to a human.
        </p>
      </header>

      <div className="md:flex md:items-start md:gap-8">
        <div className="md:w-56 md:shrink-0">
          <SectionMenu sections={inOrg ? ORG_SECTIONS : SECTIONS} active={section} onSelect={openSection} links={links}
            dirtySections={inOrg ? orgDirty.sections : dirtySections} dirty={anyDirty} counts={menuCounts} />
        </div>

        <div className="flex-1 min-w-0">
          {canOrg && (
            <div hidden={!inOrg} data-testid="org-scope">
              <h2 className="text-lg font-semibold text-un1t-text mb-4">{SECTIONS.find((s) => s.key === section)?.label}</h2>
              <OrgDefaultsClient
                ref={orgRef}
                organizationId={orgDefaults.organizationId}
                organizationName={orgDefaults.organizationName || null}
                section={section}
                onSaved={refreshInherited}
                onDirtyChange={onOrgDirtyChange}
                onOpenSection={openSection}
              />
            </div>
          )}

          <div hidden={inOrg}>
            {/* Knowledge is outside the owner-only rule (any manager+ edits it). */}
            {!canEdit && section !== 'knowledge' && section !== 'personality' && readOnlyNote}

            {SECTIONS.map(({ key, label }) => {
              const Section = SECTION_COMPONENTS[key]
              return (
                <div key={key} hidden={section !== key} data-testid={`section-${key}`}>
                  <h2 className="text-lg font-semibold text-un1t-text mb-4">{label}</h2>
                  <Section agent={agent} renderField={renderField} canEdit={canEdit} canEditVoices={canEditVoices} onOpenSection={openSection} onCountChange={key === 'knowledge' ? setKnowledgeCount : undefined}
                    readOnlyNote={key === 'personality' && section === 'personality' && !canEdit ? readOnlyNote : null} />
                </div>
              )
            })}

            {/* One bar for every section's studio settings (Knowledge saves as
                you go). Held while quiet hours are half-set, the booking link is
                invalid or the trial finisher is invalid (useAgentSettings). */}
            {canEdit && section !== 'knowledge' && (
              <SaveBar count={changedFieldCount(dirtyPaths)} holds={holds} saving={saving} savedAt={savedAt}
                error={error} onSave={save}
                errorLink={error && firstFieldError ? { section: 'bookings', message: firstFieldError } : null} onDiscard={discard} onGoTo={openSection} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
