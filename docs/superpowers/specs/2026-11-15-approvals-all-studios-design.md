# Approvals: all my studios in one list (opt-in)

Date: 15 Nov 2026. Working name: APPROVALSQ.6. Richard queued this ("both
studios in one list"). I told him I would build it as a switch on the page,
"This studio" or "All my studios", defaulting to this studio, with the studio
named on every card; he did not object. The detail is mine.

## The rule this touches

APPROVALS-LOCATION-SCOPE (`src/lib/approvals/registry.js`): `/approvals`
shows only the studio the person is switched into, so nobody approves one
studio's items while thinking they are in another. That stays the default,
and every count and badge stays on the active studio.

## The principle

The all-studios view is exactly the union of what the person would see by
switching into each of their studios in turn, and every decision is made
exactly as if they had switched into the item's studio first. Nothing about
who may see or decide anything changes, by construction:

- **Reading:** the server builds, for each studio in `user.locations`, the
  user object `getCurrentUser()` would have returned had that studio been
  active, and runs the existing registry with it. No provider changes.
- **Deciding:** every request a card sends for an item carries
  `x-active-location: <the studio the item was listed under>`. `getCurrentUser`
  already honours that header on the web and validates it against the
  person's own studios (`src/lib/auth.js` ~517-543), so each decide route sees
  the same user it would see after a switch. No decide route changes.

## Server

- `userAtLocation(user, locationId)` in `src/lib/auth.js`, beside the code
  that resolves the active studio, sharing that code rather than copying it:
  returns a copy of `user` with `activeLocation`, `activeAssignment`,
  `activeRoleTemplate`, `activeOrganization`, `role` (and any other
  active-only field `getCurrentUser` sets) recomputed for that studio;
  returns null for a studio not in `user.locations`. A test proves it equals
  what `getCurrentUser` returns under `x-active-location` for the fields the
  registry and providers read.
- `GET /api/approvals/pending?scope=all`:
  - studios = `user.locations` for which the derived user passes
    `hasPermission(derived, 'approvals_inbox')` (the page's own gate);
  - runs `getPendingApprovals(db, derived)` for each, in parallel, capped at
    12 studios (active studio first, then by name; a `truncated: true` flag
    when capped);
  - tags every item (and failed item) with `studioId` and `studioName`
    (the studio it was listed under);
  - merges providers by key; drops duplicates by `(provider key, item id)`,
    keeping the copy listed under the active studio when there is one, else
    the first (time off is person-scoped and host events are org-wide, so the
    same item can be listed under several studios);
  - each merged provider's `count` is the number of items after de-duplication
    plus failed items; `total` is their sum;
  - one studio's failure leaves that studio out and adds its name to
    `failedStudios`; it never fails the response;
  - response also carries `scope: 'all'` and `studios: [{ id, name }]`.
  - Without `scope=all` the route behaves exactly as today, byte for byte.
- `/api/approvals/count`, the sidebar badge, the dashboard queue, the phone
  widget and the today feed are untouched: active studio only.

## Web

- A switch at the top of `/approvals`: "This studio" | "All my studios",
  shown only when the person has two or more eligible studios (the default
  response gains `studios` so the page knows). The choice is remembered in
  `localStorage` per browser; default "This studio".
- In "All my studios":
  - every card shows its studio as a chip; a card from a studio other than
    the active one gets a coloured chip so it stands out;
  - a line under the switch: "Showing <n> studios. Each decision is made at
    the studio named on the card." plus, when any failed, "Could not load:
    <names>.";
  - every request any card sends for an item (decide, follow-ups, the roster
    check, undo, bulk clear, bulk undo) carries the item's `studioId` as
    `x-active-location`. One shared helper builds the headers so no call can
    forget it; in "This studio" mode no header is sent (as today).
  - link-out cards (bookkeeper queue, rosters, issues, Hyrox) and every "Open
    in <page>" link for an item at another studio first switch the active
    studio the way the existing studio switcher does, then open the page; the
    button reads "Switch to <studio> and open".
- The badge on the view buttons shows the merged totals while in "All my
  studios"; the sidebar badge keeps showing the active studio's count.

## Must not happen

- The default view or any count changing.
- An item listed, or a decision allowed, that switching into that studio
  would not list or allow.
- A request for another studio's item going out without its studio header
  (it would be judged at the active studio).
- The same item appearing twice.
- A studio the person does not belong to being named or queried.

## Not in this PR

- The phone.
- An all-studios badge in the sidebar.
