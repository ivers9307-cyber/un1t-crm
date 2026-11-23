# Mia reads the live pages and offers (MIAPAGES.1)

Date: 23 November 2026. Status: approved by Richard, 23 November 2026.

## Intent

Mia, the customer agent on WhatsApp and Instagram, cannot see what the CRM is
selling. Her only sources for an offer are the hand-written knowledge notes
(one trial entry per studio) and, at Hatch Street, a four-product "What Mia can
sell" list. On 23 November 2026 the CRM hosted eight live landing pages and 20
live `/offers` storefront offers, and Mia knew none of the prices or end dates.

Richard wants three things:

1. Mia knows every public page the CRM hosts, at every studio.
2. That knowledge updates by itself: a page going live, being retired or
   changing price reaches her with no one editing notes.
3. She applies context: she works out what the customer is looking for and
   offers what fits, not the whole list.

4. The right page leads. The baseline for a new person is the paid trial, but
   a time-limited offer such as this week's free Open Week takes priority over
   it while it runs (Richard, 23 Nov 2026).

So she always quotes the current price and end date, and the right offer.

## Goals

- One live read that returns every live landing page and every sellable
  storefront offer for the conversation's organisation, per studio, with the
  price, what is included, the end date and the page link.
- The read uses the same records and the same "is this sellable now" rules the
  public pages use, so Mia and the page can never disagree.
- Every entry says who it is for, so Mia can match it to the customer.
- Mia's rules make this read her only source for a page's or offer's price,
  end date and link.

## Non-goals

- Buying from these pages inside the chat. Mia sends the page link; the page
  takes the payment. The existing Hatch "What Mia can sell" purchase links are
  unchanged.
- A per-page "Mia may mention this" switch. Richard chose every live page
  (23 Nov 2026).
- Events. Mia already reads those live with `list_upcoming_events`.
- The staff assistant and the MCP server. This is Mia only.
- Pages outside this CRM (champ-app, un1t.online's own site).

## Anti-goals

- A price or end date that is out of date, rounded or invented.
- Mia reciting the whole list to someone who asked a narrow question.
- Mia offering something the page itself would refuse: a sold-out offer, an
  Open Week that has finished, a promo that is switched off.
- Any internal key in the result: a promo key, a product id, a plan code.
- A stock count. Mia may say an offer is limited, never how many are left.
- "There are no offers" when the read failed. A failed read is "unknown".
- Pitching unprompted. Mia answers and suggests when the customer's message
  makes an offer relevant; she does not open a conversation with a sale.

## Constraints

- Every read runs on the service role, so it is scoped in code: by the
  conversation's organisation, then by studio (`docs/rules/data-access.md`).
- `locations.settings` holds credentials. The reader selects named columns and
  never returns a `locations` row or its settings to the model.
- Zone maths only through `@/lib/location-time`; an end date is rendered in
  the studio's own timezone.
- A select returns at most 1,000 rows and every `.select()` column must exist
  (`check:select-columns`).
- Tool text sent to the model has no em or en dashes (existing convention in
  `tool-blocks.js`).
- Mia's tool blocks are byte-stable for the prompt cache. Adding a tool moves
  the cached prefix once, on deploy; the fixtures in
  `src/lib/agent/__fixtures__/` are regenerated.
- Mia stays on the Anthropic Messages API.

## Approaches

**A. A live read tool, called when needed (chosen).** A new tool,
`list_current_offers`, reads the pages and storefront on demand, the way
`list_upcoming_events` reads events. Always current to the second. Costs
nothing on the many turns that are not about buying. Relies on Mia calling it,
which her rules require before she states any price or end date, and which the
existing tools show she does reliably.

**B. Put the whole list in every prompt.** Mia can never forget to look, but
around 30 entries are added to every message she answers, most of which are
"what time is class tomorrow". It also sits in the uncached part of the
prompt, so it is paid for in full each turn.

**C. Copy pages into the knowledge notes on a schedule.** No change to Mia's
rules, but the notes are stale between runs, a sale that ends at 23:59 is
still quoted at 00:05, and two copies of every price exist. This is the
problem being fixed.

Richard handed over the how; A is Claude's pick, for freshness and cost.

## Design

### The tool

`list_current_offers`, no input, no identity check (it is public information,
like `list_upcoming_events`). Offered in all five tool blocks and on every
channel. Its executor never throws.

It answers for every studio of the conversation's organisation that has at
least one entry, the conversation's studio first, each under its studio name:

```
{
  studios: [
    { studio: "UN1T Stillorgan", this_conversation: true,
      pages: [
        { title: "14 Day Reset", kind: "paid_trial",
          for: "Someone new who wants to try the studio.",
          summary: "14 days of unlimited classes.",
          price_label: "€39", ends_label: null,
          url: "https://…/trial" }
      ],
      store: [
        { name: "20 Class Pack", category: "class_pack",
          bonus: "+5 free classes", price_label: "€380",
          ends_label: "Mon 30 Nov, 23:59", opens_label: null,
          limited: false, sold_out: false, url: "https://…/offers/stillorgan/20-class-pack" }
      ] }
  ]
}
```

- **Pages** are `landing_pages` rows with `publish_state = 'live'`, joined to
  their `landing_page_studios` rows with `enabled = true`
  (`pageStudioRows` applies the one-studio rule). The offer is the merged
  block (`mergeOfferBlock`) and it is included only when the page itself
  would take a customer right now. That is `offerConfigured` plus every check
  the public route makes on top of it, the Open Week window
  (`src/lib/open-week.js`) among them: a promo page whose window has ended is
  left out, as the page shows "finished". A page with offer type `none` is
  listed with its title, summary and link and no price.
- **One trial, one link.** The studio pages (`kind = 'studio'`, `/stillorgan`
  and `/hatch-street`) sell the same trial as `/trial`. Each studio page is
  listed once as the studio's own page, without an offer; an offer appears
  under the campaign page that sells it. When only a studio page sells an
  offer, it keeps it.
- **Price.** A paid trial's `price_label` is its price. A promo page's is
  "Free", and its summary gives the number of classes from the promo row. A
  page that stores no price (a one-class page such as `/50plus`) has
  `price_label: null`; Mia says the page has the details and never guesses.
- **End date.** Pages have no end date of their own. `ends_label` is set for a
  store offer (`ends_at`) and for a promo with a window (`window_ends_on`),
  and is null otherwise.
- **Store** is `sellableSaleOffers(db, locationId)`, unchanged, so it carries
  the storefront's own rules (active, open now or opening later, payment rail
  ready). A page of type `sale` lists its link only; its offers appear once,
  under `store`.
- **`for`** is how Mia applies context. It defaults from the offer type:
  paid trial, "someone new who wants to try the studio"; promo credits and one
  class, the page's own title and summary (these pages are each aimed at a
  different group: new people, a company's staff, the over-50s); sale, "anyone
  buying a pack, a membership or a gift".
  The page editor gains one optional line per page, "Who is this for? (Mia
  reads this)", stored on the page and used in place of the default when set.
- **`summary`** comes from the page's own copy (the offer block's headline or
  the hero's), trimmed to one line, so it changes when the page is edited.
- No promo key, plan code or product id is ever in the result. (Promo pages
  take no code from the customer: the key belongs to the page.)
- **`limited`** is true when the offer has a stock limit, and **`sold_out`**
  when `readOfferStock` (`src/lib/offer-stock.js`) says none are left, the
  same read the storefront uses for its "Sold out" label. No number, ever. A
  sold-out offer stays in the list so Mia can say it has gone.
- **`url`** is the public address a customer would use at that studio, built
  by the same helper the pages use for their own links.
- **Labels** (`price_label`, `ends_label`, `opens_label`) are formatted on the
  server, in the studio's timezone, so Mia copies them and does no maths.

### Which page leads

Each studio's `pages` list reaches Mia already ranked, and every entry carries
`priority`: `lead`, `normal` or `only_if_asked`. Mia offers the lead entry and
mentions the next one only when the lead does not suit the customer.

The rank is automatic, with an override (Richard chose both, 23 Nov 2026):

1. Pages the operator set to "Lead with this", in title order.
2. Pages with an offer that has an end date and is open now, soonest end
   first. This is what puts Open Week above the paid trial for its week.
3. Every other page with an offer, the paid trial first: it is the baseline,
   and leads a standing free promo or a one-class page (New Start, the 50+
   Club) that has no end date.
4. Pages without an offer of their own (studio pages, the sale page).
5. Pages the operator set to "Only if asked", flagged `only_if_asked`.

The first page in groups 1 to 3 is `lead`; when the operator marked several,
each of them is. Nothing is stored about the outcome: the rank is worked out
on every read, so when Open Week's window ends it leaves the list and the
paid trial leads again with no one touching anything.

The override is one setting per page in the page editor, "Mia's priority":
Automatic (the default), Lead with this, Only if asked. It is saved in the
page's settings beside the "Who is this for?" line.

Store offers keep the storefront's own order and carry no priority.

### Failure

A source that cannot be read is reported, never emptied: the studio's entry
carries `pages_unreadable: true` or `store_unreadable: true`, and when nothing
could be read the tool returns `{ error: 'offers_unreadable', message }`
telling Mia to say she cannot check right now and offer the team. Failures are
logged with `logWarn`/`logError`, never `console.log`.

### Mia's rules

Changes to `src/lib/agent/prompt.js`, in every block:

- A page's or offer's price, what it includes, its end date and its link come
  only from `list_current_offers` in this conversation, copied exactly. The
  knowledge notes stay the source for everything else (classes, policies,
  hours). When the two disagree about an offer, the tool wins.
- Call it before answering anything about trying the studio, joining, prices,
  packs, gift cards, deals or a sale, and again rather than relying on a price
  from an earlier message in the thread.
- **Apply context.** First work out what the customer is after (trying the
  studio, a membership, more classes, a gift, a company promo) and what is
  already known about them (new, on a trial, a member, which studio). Then
  offer the one or two entries whose `for` fits, with the price, the end date
  when there is one, and the link last. Never list everything. If it is not
  clear what they want, ask one short question first.
- Never offer a trial or a new-customer page to someone known to be a current
  member. Offer a page aimed at a group (a company's staff, the over-50s) only
  when the customer's own words put them in it. Mia does not check
  eligibility: she says who the offer is for and that the page confirms it.
- **Free.** Mia may say "free" for an entry whose `price_label` is "Free",
  and only then. The two existing rules that forbid mentioning a free class
  or answering an offer question unless the knowledge notes settle it
  (`prompt.js` lines 442 and 453 today) are reworded: the tool's entries may
  be described; whether one person is entitled to something still goes to
  the team.
- **When they say yes.** If what they want is an entry on the list, Mia sends
  that entry's link, ending her message with it. `request_membership_purchase`
  (a card for the team) stays for a yes to something that is not on the list,
  and the membership sign-up link stays for a plain "I want to join" when no
  live entry fits. (Confirmed by Richard, 23 Nov 2026.)
- **Lead first.** Among the entries that fit the customer, offer the one
  marked `lead`. Mention the next one only when the lead does not suit them
  (they cannot make the dates, they are not who it is for). Bring up an
  `only_if_asked` entry only when the customer's own words ask for it.
- Say an offer is limited or sold out when the tool says so, never a number,
  and never link a sold-out offer.
- An offer for another studio is named as that studio's.
- The existing trial rule ("offer the trial KNOWLEDGE describes") reads the
  trial from the tool instead.
- At Hatch Street, where Mia can also send a payment link in chat, a live
  storefront offer that matches what the customer asked for is mentioned with
  its page link alongside the in-chat options, so a sale price is never
  hidden behind a regular one.

### Page editor

One optional text field on the page settings, "Who is this for? (Mia reads
this)", up to 200 characters, saved with the page in its existing settings
(`landing_pages.chrome`), so no migration is needed.

### Tests

- The reader and the view builder, against `createFakeDb`: live versus draft,
  disabled studio row, offer not ready, ended and not-yet-open store offers,
  a failed read on each source, no code or product id in any result, labels in
  the studio's timezone.
- Tool blocks: the tool is offered in all five and refused in none; fixtures
  regenerated.
- Prompt tests for the new rules.

## Left to the builder

- The exact tool description and rule wording, within the points above.
- Which existing helper builds the public URL per studio and tenant domain.
- Where the summary line is taken from for each block type.
- File layout (expected: `src/lib/agent/offer-tools.js` beside
  `event-tools.js`, wired in `auto-reply.js`).

## Claude's calls, for Richard to check

- A tool rather than the list in every prompt.
- "Open now with an end date" is what makes an offer outrank the baseline; a
  time-limited store offer does not outrank a page, since store offers are for
  people buying, not people trying.
- The optional "Who is this for?" line per page, with a default by offer type.
- Mia never gives a stock number, only "limited".
- Promo pages are mentioned only when the customer raises the company or code.
- Other studios' offers are included, labelled by studio.
- Mia sends the link; she does not sell these in chat.
- Mia may say "free" for the free-class pages, since every live page may be
  mentioned.
- Mia does not check who is eligible; the page does.
- The trial is listed once, with the `/trial` link, not again under each
  studio page.
- A sold-out offer is still listed, marked sold out, so she can say it has gone.
- A studio is listed whenever a live page is switched on there. Test Studio
  is switched off on every page today; switching a page on there would make
  Mia name it.
