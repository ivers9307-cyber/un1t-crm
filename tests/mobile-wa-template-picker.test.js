// WATPLPICKER.1 — the phone's WhatsApp template picker, pinned as source.
//
// WHY A SOURCE SCAN. vitest reaches mobile/lib and shared/ tests and nothing
// under mobile/app: there is no React Native component runner. The decisions
// (what can be sent, the request body, the preview) live in
// shared/wa-template-send.js and are tested there. What is left is a handful of
// facts about the screen: it must call those helpers rather than rebuild them,
// and the two shapes that broke it must not come back. A floor, not proof; the
// handset check is the rest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
const SCREEN = read('mobile/app/(staff)/whatsapp/[conversationId].jsx')

describe('phone WhatsApp thread: template picker', () => {
  it('never reads a template body_text/header_text field (no such columns; the picker 400d from 2026-04-30)', () => {
    // Card sets DO carry a body_text (their own API field), so only template
    // variables are checked here.
    expect(SCREEN).not.toMatch(/\b(?:t|tpl|chosenTemplate)\.(?:body_text|header_text)\b/)
    expect(SCREEN).not.toMatch(/\bheader_text\b/)
  })

  it('never sends a template with no parameters or a hard-coded language', () => {
    // The old call: sendTemplate(conversationId, tpl.name, [], …) with 'en' fixed
    // inside the helper. 17 of 18 live templates need body parameters.
    expect(SCREEN).not.toMatch(/sendTemplate\([^)]*,\s*\[\]\s*,/)
    expect(SCREEN).toMatch(/sendTemplate\(conversationId, built\.payload, activeLocation\?\.id\)/)
  })

  it('builds the send, the preview and the greyed-out rows with the shared helpers', () => {
    expect(SCREEN).toMatch(/from 'shared\/wa-template-send'/)
    for (const fn of ['buildTemplateSend(', 'templateSendBlock(', 'renderTemplatePreview(', 'initialTemplateValues(', 'bodyVariableSlots(']) {
      expect(SCREEN).toContain(fn)
    }
    expect(SCREEN).toContain('templateBodyText(t)')
    expect(SCREEN).toContain('SEND_BLOCK_TEXT[block]')
  })

  it('picking a template does not send it: Send is a separate, explicit press', () => {
    expect(SCREEN).toMatch(/onPress=\{\(\) => chooseTemplate\(t\)\}/)
    expect(SCREEN).toMatch(/onPress=\{sendChosenTemplate\}/)
  })
  it('a template send cannot fire twice from a double tap (a ref, set before the await)', () => {
    expect(SCREEN).toMatch(/if \(sendingTplRef\.current\) return/)
    expect(SCREEN).toMatch(/sendingTplRef\.current = true[\s\S]*await sendTemplate\(/)
    expect(SCREEN).toMatch(/finally \{\s*sendingTplRef\.current = false/)
  })
  it('{{1}} is prefilled from the contact first name only, as the web does', () => {
    expect(SCREEN).not.toMatch(/wa_profile_name\?\.split/)
  })
  it('the preview says when a video/image/document goes with the template', () => {
    expect(SCREEN).toContain('templateHeaderMedia(chosenTemplate)')
  })
})
