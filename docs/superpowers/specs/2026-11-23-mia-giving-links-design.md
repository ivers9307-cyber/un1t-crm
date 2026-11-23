# MIAGIVING.1: Mia can link to a raffle or donation page after the event

Approved by Richard, 23 Nov 2026.

## Why

A customer asked Mia on the Hatch Street number for "the charity day link".
The charity day was a Stillorgan event on 21 Nov. Its online raffle and its
donation page were both still open, but `list_upcoming_events` reads only
future events at the conversation's own studio, so it came back empty and Mia
handed over to the team.

## What changes

`list_upcoming_events` returns a second list, `still_giving`, beside `events`.

An event is in `still_giving` when all of these hold:

- it is a UN1T event (`host_id` null), `active`, `status = 'published'`
- its studio belongs to the conversation's organisation and is active
- its date has passed (before today on its own studio's clock)
- and either
  - its raffle sells online right now (`onlineSalesState(raffle).open`), or
  - `charity_enabled` is true and the date is within the last 30 days.

Each entry carries: `name`, `studio`, `this_conversation`, `date` (label),
`charity` (name or null), `raffle_open`, `raffle_closes_label` (or null),
`donations_open`, `url` (`<event studio's customer host>/event/<slug>`).
Nothing else: no totals, ticket numbers, prices, buyers or ids.

The 30 days is a constant (`GIVING_WINDOW_DAYS`); nothing in the data sets an
end to donations, so this is the builder's call, agreed with Richard.

## Rules

- Upcoming events, bookings, cancellations and moves stay scoped to the
  conversation's studio. Only `still_giving` reads across the organisation.
- A failed read is "unknown", never "nothing open": the result carries
  `still_giving_unreadable: true` and Mia says she could not check.
- A raffle read that fails for one event leaves that event in the list only if
  donations qualify it, and sets `still_giving_unreadable`.
- The empty-result message is only returned when both lists are empty and
  nothing was unreadable.
- Prompt: Mia sends the `url` when asked about a past event's raffle or
  donations, names the studio when it is not this conversation's, quotes
  `raffle_closes_label` as written, never says how much was raised, and never
  raises giving unprompted.

## Approaches considered

1. **Extend `list_upcoming_events`** (chosen). Mia already reaches for this
   tool when asked about an event, as she did in the failed conversation.
2. Add a list to `list_current_offers`. Already organisation wide, but an
   event is not an offer and Mia would not look there.
3. A new tool. One more thing for her to choose between, for a rare question.

## Not in scope

Upcoming events at other studios; third-party host events; any change to the
public event page; a per-event closing date for donations.

## Left to the builder

Query shape, file layout (a new `event-giving.js` beside `event-tools.js`),
test fixtures, prompt wording within the rules above. No migration.
