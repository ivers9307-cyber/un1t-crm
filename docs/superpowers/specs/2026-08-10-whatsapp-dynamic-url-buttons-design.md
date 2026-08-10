# Dynamic URL buttons in WhatsApp templates

**Date:** 2026-08-10
**Status:** approved, implemented (WA-TPL-URL.1)
**Follows:** WA-TPL-BTN.1 (#1351), which added the button validator and made Meta's rejection legible.

## Problem

Meta lets a URL button's link end in one variable, so a template can carry a
per-recipient or per-campaign link. Our template builder could not author one:
`buildComponents` never emitted the `example` value Meta requires, so any such
template was refused at submit time with a bare "Invalid parameter". WA-TPL-BTN.1
turned that into an honest message ("the template builder can't supply one yet")
but left the capability missing.

## The trap that shapes the design

Authoring alone is not enough, and shipping only the authoring half would be
worse than shipping nothing. An APPROVED dynamic-URL template still fails at
**send** time unless each message carries the button's parameter — Meta answers a
missing one with 132012, per recipient. That is exactly how the video-header bug
played out on 2026-06-11: the template was approved, the broadcast carried no
URL, the parameter was silently omitted, and every recipient failed.

So this lands in both halves, and a send with no value is refused outright.

## Design

### Authoring (`WATemplateEditor`, `whatsapp-template-buttons.js`)

A URL button whose link ends in `{{n}}` shows a **Sample value** input. It emits
Meta's shape — `example: ["summer2026"]`, the variable's **value only**, not the
full URL (verified against Meta's components reference; URL buttons are
positional-only, `{{named}}` is not accepted there).

`normalizeButtonsForMeta()` whitelists the fields Meta accepts per button type.
The editor mutates one button object as the operator switches its type, so a URL
and sample typed before switching to Quick Reply would otherwise ride along as
stray fields. It also drops an `example` left behind when the variable is removed
from a link — Meta rejects an example on a static URL button.

Validation from WA-TPL-BTN.1 is unchanged: one variable, at the very end, sample
required. Only the wording moved from "unsupported" to "fill in the sample field".

### Sending (`buildTemplateComponents`, `sendBroadcast`, `sendDripChunk`)

`buildTemplateComponents` appends, beside the existing FLOW-button branch:

```js
{ type: 'button', sub_type: 'url', index: '<button position>', parameters: [{ type: 'text', text: value }] }
```

The value comes from the reserved mapping key **`url_button`** and resolves
through the same `resolveContactField` path as body variables. The key is not a
number on purpose: Meta numbers a button's variables independently of the body's,
so a bare `"1"` would collide with the body's `{{1}}`. Because that resolver falls
back to the literal string, one field covers both a contact column (`id`, `email`)
and a fixed campaign code (`summer2026`) — which is why the UI is a free-text
input with a field datalist, not a select.

**Missing value = refuse the send**, per each path's established posture:

| Path | Behaviour |
|---|---|
| `sendBroadcast` (operator pressed Send) | `throw`, before the draft→sending flip, so a refusal leaves the broadcast in its entry state — same as the wallet and template-approval gates directly above it |
| `sendDripChunk` (cron) | set `paused_at`, return `{ skipped: 'url_button_value_missing', paused: true }` — the same shape as `template_not_approved`, so the cron doesn't error-loop every tick |

`buildTemplateComponents` also omits the parameter when nothing is mapped. That
is belt to the gate's braces, not the gate itself.

### Composers

Both send surfaces gain one field, shown only when the selected template has a
dynamic URL button: `WABroadcastEditor` (per-broadcast) and
`UnifiedSendComposer` (`/communications/send`). Each states the link it appends
to and that the send is refused without it.

## Blast radius

The new blocking condition can only fire for a template whose URL button carries
a variable. No such template exists today, so nothing currently scheduled can be
caught by it.

## Testing

Pure-lib, no DB: `dynamicUrlButtonIndex`, `urlButtonSendBlock`,
`normalizeButtonsForMeta` (type-switch residue, stale examples, COPY_CODE,
Meta-synced `flow_action`), and `buildTemplateComponents` — parameter shape and
index, contact-field vs literal resolution, omission when unmapped, and a FLOW
button coexisting with a URL button at its own index.

## Not doing

- **Named parameters in URL buttons** — Meta does not accept them.
- **More than one variable, or a variable mid-URL** — Meta's rule, enforced with
  its own message.
- **A template-level default link value** — rejected in design; it would mean a
  migration and two places to look when a link is wrong. Per-send only.
