# Segment stage change report — UN1T Group, 2026-10-20

**Decision 3 (spec `docs/superpowers/specs/2026-10-20-org-shared-contacts-whatsapp-design.md` §5):** audiences, list filters and dormancy become per studio. Before the flip of the `pipeline_stage_slug` audience field onto the stage at the audience studio (`contact_location_audience.studio_stage_slug`, mig 766) merges, this is what changes. **Richard reads this before Task 21's commit merges** (plan PR 5).

**How it was computed.** Read-only, on prod (`iyvtbjjxdggiadzwwvdj`) at ~17:55 on 20 Oct 2026, through Supabase MCP SQL that mirrors `applyAudienceFilter`: `eq` is equality (a NULL never matches), `neq` is `IS DISTINCT FROM` (null-inclusive, COMMSFIX.B.1), `days_since_gt` is null-inclusive; each audience scoped to its studio (`audience_location_id`) and the email consent flag (`loc_email_marketing`), the send path's own scope minus its later status gates. The checked-in script does the same through the app's own filter code and the view:

```bash
node scripts/segment-stage-change-report.mjs --org <UN1T organisation id> --out report.md
```

Counts only; no names or ids.

## What filters on the stage today

| source | rows naming `pipeline_stage_slug` |
|---|---:|
| contact_segments (saved segments) | 0 |
| campaigns | 8 (2 draft, 6 sent) |
| whatsapp_broadcasts | 0 |
| email_sequences | 1 (inactive) |

## The audiences, before and after

| audience filter | studio | where it is used | before | after | joined | left | joined: stage NULL at studio | left: stage NULL at studio |
|---|---|---|---:|---:|---:|---:|---:|---:|
| stage **neq** member | UN1T Hatch Street | 1 draft + 1 sent campaign | 230 | 263 | **33** | 0 | 23 | 0 |
| stage **eq** member | UN1T Stillorgan | 1 draft + 1 sent campaign | 666 | 666 | 0 | 0 | 0 | 0 |
| stage eq member **or** eq pack_member | UN1T Stillorgan | 1 sent campaign | 778 | 778 | 0 | 0 | 0 | 0 |
| stage eq active_member | UN1T Stillorgan | 1 sent campaign | 0 | 0 | 0 | 0 | 0 | 0 |
| stage neq active_member | UN1T Stillorgan | 2 sent campaigns | 2,990 | 2,990 | 0 | 0 | 0 | 0 |
| membership status not member/credit_member **and** stage not pack_member/member/converted **and** last attended > 182 days ago or never | UN1T Stillorgan | 1 inactive sequence | 2,101 | 2,101 | 0 | 0 | 0 | 0 |

**Reading it.** Every Stillorgan audience is unchanged: at a Glofox studio the contact-wide stage already is the Stillorgan stage for everyone whose primary studio is Stillorgan, and the 131 Stillorgan rows whose value changes (below) are Hatch-primary people with a lead row at Stillorgan, whom no saved Stillorgan audience targets. The one change is at Hatch: "not a member" grows by 33, nobody leaves. Those 33 are Stillorgan members (contact-wide stage `member`) who at Hatch are a lead or a client, 23 of them with no stage at Hatch at all (the Review Focus 4 class, in the join direction: a null-inclusive `neq` now includes them). That is the intended correction: they are not Hatch members, so Hatch's "not a member" campaign may reach them. The draft campaigns are the live effect; the sent ones only show what would have differed.

## Rows whose stage value changes (every preferences row, not only saved audiences)

| studio | audience rows | same stage | differs | of which NULL at the studio | no relationship row | primary-studio rows that differ |
|---|---:|---:|---:|---:|---:|---:|
| UN1T Hatch Street | 298 | 218 | 80 | 38 | 0 | 0 |
| UN1T Stillorgan | 8,949 | 8,818 | 131 | 118 | 0 | 0 |

Every preferences row has a `contact_studios` row, and a person's stage never differs at their primary studio. The biggest transitions: at Stillorgan, 102 rows go `waitlist_new_enquiry` → NULL (Hatch waitlist people with a lead row at Stillorgan); at Hatch, 28 rows go `member` → NULL (Stillorgan members with a lead or client relationship at Hatch and no deal there), 16 go `dormant` → `waitlist_new_enquiry` / `new_lead` (dormant at Stillorgan, live enquiries at Hatch), 6 go `member` → `converted`.

## What the builder gains

`is_null` / `is_not_null` are already operators on the stage field; after the flip they mean "no stage at this studio", so a Hatch segment that wants exactly the Review Focus 4 class can ask for it. The field's label becomes "Pipeline stage (at this studio)".
