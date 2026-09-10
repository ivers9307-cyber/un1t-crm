// MAIL-READER.M1 — the mobile reader's load-bearing literals, pinned as source.
//
// WHY A SOURCE SCAN. vitest reaches mobile/lib/**/*.test.js and nothing else
// under mobile/: no jsdom, no runner for mobile/app or mobile/components. Every
// DECISION therefore lives in mobile/lib and is tested properly there. What is
// left is a handful of facts about the JSX itself — an import that must be gone,
// a helper that must be called rather than reimplemented inline — and this file
// holds those. It is a floor, not proof; the device is the rest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const THREAD = 'mobile/app/(staff)/email/[conversationId].jsx'
const COMPOSE = 'mobile/app/(staff)/email/compose.jsx'
const FORWARD = 'mobile/app/(staff)/email/forward.jsx'
// MOBILE-CONTACT-SEND.1's composer on the contact card. Not in Task 11's own
// file list, but it carried the identical box for the identical reason, and
// desktop's decision 2 was "no signature preview in ANY composer" — leaving
// one behind would show an operator the sign-off in one place and not the
// other, which is the inconsistency this branch exists to close.
const CONTACT_MODAL = 'mobile/components/ContactComposeModal.jsx'
const COMPOSERS = [THREAD, COMPOSE, FORWARD, CONTACT_MODAL]

describe('the signature preview box is gone from every composer', () => {
  // MAIL-READER.1 decision 2, and the reason it costs nothing here: the box was
  // added (MOBILE-SIGHINT.1) because the phone has no signature editor to link
  // to, which is also why deleting it removes nothing an operator can act on.
  it.each(COMPOSERS)('%s does not render it', (file) => {
    const source = read(file)
    expect(source).not.toContain('resolveSignatureHint')
    expect(source).not.toContain('signature-hint')
    expect(source).not.toContain('Added automatically')
  })

  it.each(COMPOSERS)('%s no longer fetches signature contexts for a preview', (file) => {
    expect(read(file)).not.toContain('fetchSignatureContexts')
  })
})

describe('the composer cap comes from the lib', () => {
  it('the thread screen calls composerCap and hand-writes no fraction', () => {
    const source = read(THREAD)
    expect(source).toContain('composerCap(')
    // The fraction and the floor are the lib's, pinned by its own tests. A
    // second copy here is a second thing to change when Richard moves it.
    expect(source).not.toMatch(/\*\s*0\.4\b/)
  })
})

describe('the note composer still states its mode in words', () => {
  it('keeps the staff-only sentence, uncompacted', () => {
    // 🔴 The invariant this screen is built around: the composer says which
    // mode it is in three ways — the selected segment, the colour of the card,
    // and the sentence naming exactly who receives what. Only the REPLY half of
    // MAIL-READER.1 decision 3 compacts; this sentence does not.
    expect(read(THREAD)).toContain('NOT sent to')
  })
})

describe('an attachment opens IN the app, not by handing it to the OS', () => {
  // MAIL-ATTACH.M1. Tapping a PDF used to open Chrome and download the file.
  // Two causes: only 'image' asked for an inline url (so a PDF took the
  // download one, whose Content-Disposition: attachment defeats every viewer),
  // and Linking.openURL handed the url to whatever app claimed it.
  it('routes the tap through attachmentOpenPlan rather than testing preview_kind inline', () => {
    const source = read(THREAD)
    expect(source).toContain('attachmentOpenPlan(')
    // The inline test is what sent PDFs down the download path.
    expect(source).not.toContain("att.preview_kind === 'image'")
  })

  it('opens with the in-app browser, keeping Linking only as the fallback', () => {
    const source = read(THREAD)
    expect(source).toContain('WebBrowser.openBrowserAsync')
    expect(source).toContain('async function openInApp')
    // 🔴 The ORDER, not just the presence of both. A scan that only checked
    // both strings existed would pass a file that had quietly gone back to
    // reaching for Linking first — the exact regression this fixed.
    //
    // Comment lines are stripped before counting: this file explains the
    // Linking fallback in prose twice, and a scan that counted those would be
    // measuring the documentation rather than the code.
    const code = source.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    const webBrowserAt = code.indexOf('WebBrowser.openBrowserAsync')
    const linkingCalls = [...code.matchAll(/Linking\.openURL/g)].map(m => m.index)
    // Exactly one: openInApp's fallback. The message-body link path lives in
    // EmailBody.jsx and reaches Linking through openHref, not from here.
    expect(linkingCalls).toHaveLength(1)
    expect(linkingCalls[0]).toBeGreaterThan(webBrowserAt)
  })

  it('adds no native module to do it', () => {
    // 🔴 The whole surface was built to stay OTA-shippable. expo-web-browser
    // drives a SYSTEM browser component and is already in the shipped binary
    // (a dependency, and registered in app.config.js's plugins);
    // react-native-webview would be a native module — new binary, App Review.
    const pkg = JSON.parse(read('mobile/package.json'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(deps['expo-web-browser']).toBeTruthy()
    expect(deps['react-native-webview']).toBeUndefined()
    expect(read('mobile/app.config.js')).toContain('expo-web-browser')
  })
})

describe('the header and the verbs read the lib', () => {
  // NOTE ON 'accountChipLabel(' vs the task file's 'shortMailboxLabel(': the
  // header chip has always called accountChipLabel (it wraps shortMailboxLabel
  // and adds the '@' prefix / NO_MAILBOX_LINE fallback — see
  // mobile/lib/mail-conversations.js). Asserting the inner function's name
  // would fail against the correct call and only pass if the screen bypassed
  // accountChipLabel to re-derive the '@' formatting itself — the opposite of
  // what this describe block is checking for. Pinning the wrapper that is
  // actually called is what proves the screen reads the lib.
  it.each(['headerDetailLines(', 'accountChipLabel(', 'spamActionLabel(', 'audienceSummary('])(
    'the thread screen calls %s',
    (call) => { expect(read(THREAD)).toContain(call) },
  )
})
