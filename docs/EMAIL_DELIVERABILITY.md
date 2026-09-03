# Email deliverability — Primary vs Promotions

Why our marketing emails keep landing in Gmail's Promotions tab, and what
to do about it. Covers domain auth, sending hygiene, and a text-first
template for the high-intent sends where Primary placement actually
matters.

## TL;DR

Gmail's Promotions tab exists for emails that look and feel like bulk
marketing — branded HTML, big banners, CTAs, sent to a segment list.
Our current `un1t-brand-emails` template hits every one of those
signals on purpose (it's a *good* branded template). That's fine for
hype emails and newsletters.

For the sends where Primary placement actually matters — welcome,
trial-no-show follow-ups, "we miss you", booking nudges — we need a
**second** template that deliberately looks like a personal email from
a coach. That template lives in this doc.

The other half of the fix is domain reputation: SPF/DKIM/DMARC aligned,
marketing on a subdomain, suppress dead addresses.

## What signals Promotions to Gmail

Gmail's classifier looks at, roughly in order of weight:

1. **Sender reputation** of the From domain and IP. Bulk senders get
   bulk placement.
2. **Authentication** — SPF, DKIM, DMARC. Missing or misaligned auth
   tanks reputation.
3. **List-Unsubscribe header** present (required by Gmail's Feb 2024
   sender rules for bulk senders — we have to include it, but it's
   itself a Promotions signal).
4. **Visual structure** — multi-column tables, big hero images,
   prominent CTA buttons, high image-to-text ratio.
5. **Copy patterns** — "SALE", "FREE", "LIMITED TIME", "BOOK NOW",
   "DISCOUNT", excessive exclamation marks, urgency framing, ALL CAPS
   subjects.
6. **Send pattern** — many recipients, identical content, sent in a
   short burst.
7. **Engagement history** — recipients who never open, mark as spam,
   or auto-archive shift the placement for everyone else.

We can't change #1, #3, or #6 if we want a marketing stack at all.
We *can* fix #2, soften #4 and #5 for high-intent sends, and clean up
#7.

## Domain authentication

Required for the From domain used by every marketing send. Check the
current state by sending a campaign to a personal Gmail, opening the
message → three-dot menu → "Show original", and looking for:

```
SPF:    PASS with IP ...
DKIM:   'PASS' with domain ...
DMARC:  'PASS'
```

All three must say PASS for the sending domain. If any say FAIL,
SOFTFAIL, NEUTRAL, or NONE, fix that before anything else — it's the
single biggest lever.

### Setup

In Cloudflare DNS for the sending domain:

- **SPF**: TXT record on root with `v=spf1 include:<ESP-include> ~all`
  (ESP-include comes from whoever sends — n8n SMTP provider, ManyChat,
  Klaviyo, etc.).
- **DKIM**: CNAME records the ESP provides (usually two, named like
  `<selector>._domainkey`).
- **DMARC**: TXT record at `_dmarc.<domain>` with
  `v=DMARC1; p=quarantine; rua=mailto:dmarc@un1tdublin.com; pct=100; adkim=s; aspf=s`.
  Start with `p=none` for the first 2 weeks to monitor, then move to
  `p=quarantine`.

## Subdomain for marketing

Sending marketing from `un1tdublin.com` directly poisons the domain
reputation that our booking confirmations, password resets, and
transactional emails depend on. Marketing has bursty patterns and
lower engagement — it drags the whole domain down.

Fix: send marketing from `mail.un1tdublin.com` (or similar) and keep
`un1tdublin.com` for transactional only. Set up SPF / DKIM / DMARC on
the subdomain independently. The two reputations are then separate
and a bad day on marketing doesn't break the trial-confirmation flow.

## Engagement hygiene

- Suppress addresses that haven't opened in 90 days. Sending to dead
  addresses is the fastest way to wreck domain reputation.
- Remove hard-bounce addresses immediately.
- Don't reuse purchased / scraped lists. Ever.
- If we ever do a re-engagement push to dormant addresses, do it as a
  separate small batch from a separate subdomain so the fallout is
  contained.

## Which template for which email

Two templates. Pick by intent, not by aesthetic preference.

| Email type | Template | Why |
|---|---|---|
| Class launch / new bootcamp | Branded HTML | Promotional content. Gmail is right to put it in Promotions; users browse Promotions specifically for this stuff. |
| Monthly newsletter | Branded HTML | Same. |
| Sale / Black Friday / member offer | Branded HTML | Same. |
| Welcome (post-signup) | **Text-first** | Critical to be seen. Single transactional-feeling email from a person. |
| Trial-no-show follow-up | **Text-first** | High intent. Must land in Primary. |
| "We miss you" / re-engagement first touch | **Text-first** | If this lands in Promotions, the user never sees it. |
| Trial → membership conversion nudge | **Text-first** | Same. |
| Booking confirmation / class reminder | **Text-first** (transactional) | Transactional emails should never look like marketing. |
| Class cancellation notice | **Text-first** | Operational. Has to land. |

## Text-first template

This is deliberately the opposite of the branded template. Looks like
a coach typed it on a phone. Single column, no banner, no big CTA
button — just a text link. Short. From a real person's name.

Drop this into n8n / ManyChat / whichever ESP and replace the
`{{placeholders}}`. Keep the From name as a real coach (or "Richard at
UN1T"), the From address as that coach's actual mailbox, and Reply-To
the same so replies actually land somewhere monitored.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>{{subject}}</title>
</head>
<body style="margin:0; padding:0; background-color:#ffffff;">
  <!-- Preheader (hidden but shown in inbox preview) -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    {{preheader}}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0"
         width="100%" style="background-color:#ffffff;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"
               width="100%" style="max-width:560px;">
          <tr>
            <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.5; color:#222222;">

              <p style="margin:0 0 16px 0;">Hi {{first_name}},</p>

              <p style="margin:0 0 16px 0;">{{opening_line}}</p>

              <p style="margin:0 0 16px 0;">{{body_paragraph_1}}</p>

              <p style="margin:0 0 16px 0;">{{body_paragraph_2}}</p>

              <p style="margin:0 0 16px 0;">
                {{soft_cta_intro}}
                <a href="{{cta_url}}" style="color:#222222; text-decoration:underline;">{{cta_link_text}}</a>.
              </p>

              <p style="margin:0 0 4px 0;">Thanks,</p>
              <p style="margin:0 0 24px 0;">{{sender_first_name}}</p>

              <!-- Plain footer: address + unsubscribe. No social icons,
                   no big "follow us" block — looks like the bottom of a
                   normal email. -->
              <p style="margin:24px 0 8px 0; font-size:12px; color:#888888; line-height:1.4;">
                Champ Fitness Ltd · UN1T Dublin · Stillorgan, Co. Dublin
              </p>
              <p style="margin:0; font-size:12px; color:#888888; line-height:1.4;">
                Don't want these? <a href="{{unsubscribe_url}}" style="color:#888888; text-decoration:underline;">Unsubscribe</a>.
              </p>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

### Copy rules for text-first sends

- Max ~120 words total body.
- No headings, no bold "BUY NOW", no emoji.
- One sentence per paragraph where possible.
- CTA is a text link inside a sentence, not a button. Example:
  *"If you want to grab a slot, [book your trial here](...)."*
- Subject line: sentence case, no caps, no emoji, no urgency. Examples:
  - "quick one about your trial"
  - "saw you didn't make it on Tuesday"
  - "Richard from UN1T — quick question"
- From name: `{coach first name} at UN1T` — e.g. `Richard at UN1T`.
- From address: a real mailbox, not `no-reply@`.
- Reply-To: same as From.
- No tracking pixel if you can avoid it. Click tracking on the single
  CTA link is fine.

### Asking users to drag to Primary

The first text-first email a new lead receives should include a
single line at the end:

> p.s. — if Gmail tucks these into Promotions, drag this one to
> Primary so you don't miss the next one. Cheers.

Gmail learns aggressively from that signal. ~5–10% of recipients
doing it shifts placement for the rest.

## Sending checklist before a campaign

- [ ] From address is on the marketing subdomain (`mail.un1tdublin.com`)
- [ ] SPF, DKIM, DMARC all pass on the From domain
- [ ] List has been suppressed of hard bounces and spam complaints
      (**not** non-openers — NOENGSUP.1/mig 537 retired engagement-based
      suppression deliberately: in a gym a member who goes quiet for a
      season is exactly who a win-back email is for, so "hasn't opened"
      is never a reason to stop mailing someone here)
- [ ] Subject line is in sentence case, no SALE/FREE/!!! triggers
- [ ] If high-intent send: text-first template, From name is a real
      coach, Reply-To is monitored
- [ ] Unsubscribe link present (List-Unsubscribe header set by ESP)
- [ ] Test send to a personal Gmail address; "Show original" shows
      all three auth records PASS
- [ ] Test send lands in the right tab (Primary for text-first,
      Promotions for branded — Promotions is fine for branded, the
      goal is to land in the *expected* tab, not always Primary)

## Inbound: recovering mail missed while the webhook was down

Postmark keeps inbound messages it could not deliver to our webhook —
errored, rejected, retries exhausted — for roughly **45 days**, and each
one can be re-pushed by hand from **Activity → Inbound** on the inbound
server (open the message, hit Retry). So an inbound outage (a
half-rotated webhook token, a broken deploy, the shim down) is
recoverable well after the fact: fix the cause, then replay the affected
window from the Activity page. Don't sit on it, though — the ~45-day
retention is the hard limit, and the `token_mismatch` / `missing_secret`
rows in `error_events` are what tell you the outage happened at all.

## Open follow-ups

- [ ] Confirm which sending domain n8n / ManyChat / Klaviyo are
      currently using.
- [ ] Audit current SPF/DKIM/DMARC on that domain (see "Domain
      authentication" above).
- [ ] If marketing is sending from the apex domain, migrate it to a
      subdomain and warm the subdomain over 2–3 weeks (start small,
      ramp volume).
- [ ] Build text-first variants of the welcome, no-show, and
      re-engagement emails using the template in this doc; A/B test
      against the branded versions on open rate and reply rate.
