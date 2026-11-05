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
// (resolveAdminOrgId). Until the scope switch (MIASETTINGS.5) its section
// shows above Overview, as before; it stays mounted (hidden) on the other
// sections so an org draft survives a switch.

import { useEffect, useState } from 'react'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
import { hubManageHref } from '@/lib/integrations-hub-links'
import OrgDefaultsClient from './OrgDefaultsClient'
import { useAgentSettings } from './useAgentSettings'
import { SECTIONS, parseLocation, writeLocation } from './sections'
import { statusOf } from './status'
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

// The section the page opens on: the URL's, made safe (sections.js). The
// organisation scope arrives with the scope switch (MIASETTINGS.5); until
// then the page is the studio's, whatever the URL says.
function initialSection() {
  if (typeof window === 'undefined') return 'overview'
  return parseLocation(window.location.search, { canOrg: false }).section
}

export default function CustomerAgentClient({ canEdit = false, orgDefaults = null, canEditVoices = false } = {}) {
  const agent = useAgentSettings({ canEdit })
  const { loading, loadFailed, reload, settings, saved, location, holds, saving, savedAt, error, save, discard, refreshInherited, dirtyPaths, dirtySections } = agent
  const [section, setSection] = useState(initialSection)

  // Leaving the page (close, reload, a typed address) with unsaved changes.
  const isDirty = dirtyPaths.length > 0
  useEffect(() => {
    if (!isDirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isDirty])

  function openSection(key) {
    setSection(key)
    writeLocation({ section: key, scope: 'studio' })
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
          <span className={`${CHIP} ${status.cls}`}>{status.text}</span>
          {quietChip && <span className={`${CHIP} border border-un1t-border text-un1t-muted`}>{quietChip}</span>}
        </div>
        <p className="text-sm text-un1t-muted mt-1">
          The AI assistant that answers customers on WhatsApp and Instagram. It answers only from its
          knowledge and hands anything else to a human.
        </p>
      </header>

      <div className="md:flex md:items-start md:gap-8">
        <div className="md:w-56 md:shrink-0">
          <SectionMenu sections={SECTIONS} active={section} onSelect={openSection} links={links}
            dirtySections={dirtySections} dirty={isDirty} />
        </div>

        <div className="flex-1 min-w-0">
          {orgDefaults?.organizationId && (
            <div hidden={section !== 'overview'}>
              <OrgDefaultsClient
                organizationId={orgDefaults.organizationId}
                organizationName={orgDefaults.organizationName || null}
                onSaved={refreshInherited}
              />
            </div>
          )}

          {/* Knowledge is outside the owner-only rule (any manager+ edits it). */}
          {!canEdit && section !== 'knowledge' && section !== 'personality' && readOnlyNote}

          {SECTIONS.map(({ key, label }) => {
            const Section = SECTION_COMPONENTS[key]
            return (
              <div key={key} hidden={section !== key} data-testid={`section-${key}`}>
                <h2 className="text-lg font-semibold text-un1t-text mb-4">{label}</h2>
                <Section agent={agent} renderField={renderField} canEdit={canEdit} canEditVoices={canEditVoices}
                  readOnlyNote={key === 'personality' && section === 'personality' && !canEdit ? readOnlyNote : null} />
              </div>
            )
          })}

          {/* One bar for every section's studio settings (Knowledge saves as
              you go). Held while quiet hours are half-set, the booking link is
              invalid or the trial finisher is invalid (useAgentSettings). */}
          {canEdit && section !== 'knowledge' && (
            <SaveBar count={changedFieldCount(dirtyPaths)} holds={holds} saving={saving} savedAt={savedAt}
              error={error} onSave={save} onDiscard={discard} onGoTo={openSection} />
          )}
        </div>
      </div>
    </div>
  )
}
