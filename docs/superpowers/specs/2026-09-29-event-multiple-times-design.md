# EVENT-MULTITIME.1 — more than one start time on a non-race event

**Ask (Richard, 29 Sep 2026):** one page for "UN1T Hatch Street Is OPEN", letting customers book the 8am **or** the 9am class. Today there are three separate events (one 9am, two 8am duplicates), all with 0 registrations.

## What already existed
Every event stores its start times as `race_waves` rows (mig 083), each with its own capacity. Races offer several (wave picker, 90-min release window, WAVEWIN.1). The register API, confirmation email/SMS, reminders and Mia's `book_event` / `reschedule_event_wave` are already multi-wave and kind-agnostic. Only two places locked non-race kinds to one wave: the CRM event form (read `waves[0]` only) and the public widget (picker hidden, first available wave auto-selected).

## Design (approved)
1. **CRM event form** (`RaceEventForm`): non-race kinds get a list of time rows (time + capacity each), "+ Add another time" / remove. All existing waves load (the old `waves[0]`-only read would have DELETED the others on save, because `PUT /api/events/[id]` diff-and-applies the wave list). New rows prefill the previous row's capacity. Duplicate times refused.
2. **Public widget** (`RaceSignupWidget`): non-race events with 2+ times show a "Choose your time" picker with every time (no release window); full times greyed, never a count. Nothing pre-selected unless exactly one time has space, so a customer is never silently booked into the first slot. Details card reads "Starts at 08:00 or 09:00". Single-time events unchanged.
3. **Customer copy:** confirmation page, email row and SMS say "Time" for non-race kinds, "Wave" for races (byte-identical race email).
4. **Data:** add an 08:00 slot (28) to the 9AM event, rename it, deactivate the two 8AM duplicates — AFTER this code deploys (the old form would delete the new slot on any edit).

Pure decisions live in `src/lib/event-time-slots.js` (tested).

## Out of scope
The host-portal event editor still edits a single session (it updates the first wave only, so it cannot delete extra times). Extend it if a host needs multiple times.
