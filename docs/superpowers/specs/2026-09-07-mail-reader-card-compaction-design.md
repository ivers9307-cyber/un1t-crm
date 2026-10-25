# Mail reader card: show the email, not the chrome

**Date:** 2026-09-07
**Task id:** MAIL-READER.1
**Mockup:** https://claude.ai/code/artifact/f18090f0-8f4f-44ff-ad75-4a9b2be833c6

## The problem

Richard's screen tonight (conversation "UN1T - Corporate offer for €189.00 per
month" from helen@earlsfort.ie) showed one collapsed line of email inside the
docked reader card. The card is `md:h-[78vh]`; everything else was chrome:

- **Above the message**: subject + chip, participants line, To/contact line,
  the action row (Archive / Mark as spam / Mark unread + the keyboard-hint
  string), and the related-conversation banner. Four bands.
- **Below the message**: the expanded composer, pinned outside the scroll
  region with no height bound: mode pills, To, textarea, the signature preview
  (the entire signature printed in a dashed box), Attach, and a footer sentence
  ("Sends an email to … · replies come back to …") beside Send.

The composer starts as a slim pill but a saved draft or a click on Reply opens
it at full size, and it stays that way.

## Decisions (Richard, 2026-09-07)

1. **Bound the composer.** Expanded, it takes at most ~40% of the card and
   scrolls inside itself. The thread keeps the rest.
2. **No signature preview in any composer.** The signature is configured on the
   account page, which keeps its own preview. ReplyBox, ComposeForm,
   ForwardForm and ContactComposer stop rendering `SignatureHint`.
3. **One toolbar row.** Attach on the left, Send on the right. The
   "sends to / replies come back to" sentence becomes the Send button's tooltip
   (and an sr-only description). Warnings that explain a disabled Send stay
   visible; the note-mode "not sent" line stays as one short line.
4. **Compact header.** Actions become icon buttons on the subject line with
   `aria-label` + `title`; the keyboard hints move behind a `?` icon's tooltip;
   the related nudge becomes an inline chip under the participants line
   instead of a full-width banner. Same data, same actions.
5. **Reading mode** (chosen over "scroll only" and "fold on demand"). When the
   composer is expanded and the operator focuses it, the header folds to one
   line: subject, sender, a compact nudge chip ("1 other"), Archive, and a
   caret that unfolds it. The composer may take up to ~46% of the card in this
   mode so thread and draft share it roughly half and half. It unfolds when
   the composer collapses, when the caret is pressed, or when the thread is
   scrolled back to the top. Nothing moves that the operator did not act on.

## Out of scope

Mobile (its thread is a different renderer and already folds messages), the
list pane, the compose dock for a NEW email (ComposeForm only loses the
signature preview), and any change to who a reply reaches.

## Verification

jsdom proves the DOM: icons carry their labels, the chip renders the nudge, the
preview is gone, the tooltip text exists, reading mode toggles the header's
one-line form on focus and back on collapse/caret. The 40%/46% caps and the
fold's feel are checked in a real browser on the Vercel preview, by Richard
(the preview sits behind the CRM login).
