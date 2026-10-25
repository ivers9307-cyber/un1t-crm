# WAHOMESTUDIO.1 — WhatsApp threads at the customer's real studio: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WhatsApp thread for a contact whose home studio is a number-less sibling in the same organisation is filed at that home studio (Hatch threads in the Hatch inbox) and replies through the organisation number it was written to / sent from.

**Architecture:** One SQL function (`move_whatsapp_conversation`, mig 723) re-files or merges a thread, used by a backfill (mig 724) and a staff "Move to studio" route. One JS helper (`numberlessHomeStudio`) decides outbound/coexistence filing; the webhook files at the contact's home studio directly. The reply resolver (`getConversationNumberConfig`) accepts a same-organisation sibling's stamped number only when the thread's studio has no number of its own, and `templateLocationIdFor` points template reads at the number owner.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes), vitest, PGlite for migration behaviour tests.

**Spec:** `docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md`

**Worktree:** `/Users/richardivers/code/un1t-crm-wa-real-studio`, branch `feat/wa-shared-number-real-studio` (off `origin/main` 944aab9d). Never `git checkout`/`pull`/bare `git stash` here.

## Global Constraints

- Same organisation only: a number is never used, and a thread never moves, across `locations.organization_id`.
- R4(b) applies ONLY when the thread's studio has **no active** `whatsapp_numbers` row; a studio with its own number is unchanged.
- An unknown sender (no matched contact) still files at the receiving studio.
- Every new `public` function: `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE … TO service_role` (mig 667).
- Mig 723 is applied BEFORE the PR merges; mig 724 right AFTER the deploy (CLAUDE.md: migration before dependent code; spec §5).
- `tests/whatsapp-config-callers.test.js` is EXACT: every change in a resolver call count updates its row in the same task.
- Webhook writes are logged, never thrown (Meta disables a hook on non-2xx).
- Fictional ids only in tests (the repo is public).
- Customer-facing copy: none added in this phase.
- Out of scope (spec §4): contact-page sends, cancellation form, radars, campaigns' audiences, `followups.js`, Flows at Hatch, mobile.

## Review Focus

1. **A thread at a studio that HAS its own number, stamped with a sibling's number** (e.g. after a manual move) → replies must still go from the studio's own number. Test in Task 2.
2. **A merge where the target thread already has a same-day agent review** → the move must not fail on `agent_conversation_reviews (channel, conversation_id, review_date)`; the target's review is kept. Test in Task 1.
3. **A template with a FLOW button sent from a thread whose template studio differs from the thread's studio** (Hatch thread, Stillorgan's templates) → refused with a 400 before Meta, not a booking at Hatch. Test in Task 7.
4. **A broadcast to a contact whose row carries no `location_id` field** (callers that select a narrow contact shape) → `getOrCreateConversation` reads it, never files at an `undefined` studio. Test in Task 4.
5. **Moving a thread to a studio in another organisation, or to its own studio** → 400, nothing written. Test in Tasks 1 and 8.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/723_move_whatsapp_conversation.sql` (create) | the move/merge function, grants |
| `supabase/migrations/724_wa_home_studio_backfill.sql` (create) | one-off backfill calling 723 |
| `tests/migration-723-724-wa-home-studio.test.js` (create) | PGlite behaviour test of both |
| `src/lib/whatsapp-config.js` (modify) | R4 sibling number, template path, `templateLocationIdFor` |
| `src/lib/whatsapp-reply-number.test.js` (modify) | R4/R5 resolver tests |
| `src/lib/whatsapp-thread-location.js` (create) | `numberlessHomeStudio` (R1) |
| `src/lib/whatsapp-thread-location.test.js` (create) | its tests |
| `src/lib/whatsapp.js` (modify `getOrCreateConversation`) | R1 + R3 on outbound |
| `src/lib/whatsapp-get-or-create-conversation.test.js` (create) | its tests |
| `src/app/api/webhooks/whatsapp/route.js` (modify) | R2, R3, numberId to coexistence, conversation id to media rehost |
| `src/app/api/webhooks/whatsapp/route.reply-number.test.js` (modify) | WANUMBERLESS cases → WAHOMESTUDIO |
| `src/lib/whatsapp-coexistence-ingest.js` (modify) | R1 on coexistence |
| `src/lib/whatsapp-media-server.js`, `src/app/api/whatsapp/media/[messageId]/route.js` (modify) | R6 media through the thread |
| `src/lib/whatsapp-consent.js` (modify) | R6 ack through the thread |
| `src/app/api/whatsapp/conversations/[id]/block/route.js` (modify) | R6 block through the thread |
| `src/app/api/whatsapp/conversations/[id]/send/route.js` (modify) | R5 templates from the number owner |
| `src/app/api/whatsapp/templates/route.js` (modify GET) | `?conversation_id=` mode |
| `src/components/WAInbox.jsx` (modify) | picker by conversation; "Move to studio" menu |
| `src/app/api/whatsapp/conversations/[id]/move/route.js` (create) | GET targets / POST move |
| `src/app/api/whatsapp/conversations/[id]/move/route.test.js` (create) | its tests |
| `src/lib/openapi.js` (modify) | register the move route |
| `tests/whatsapp-config-callers.test.js` (modify) | caller rows |
| `CLAUDE.md` (modify) | WACONFIGFALLBACK.1 exception line |
| `docs/changelog/entries/<PR>.md` (create, after `gh pr create`) | changelog row |

---

### Task 1: Migrations 723 (move function) + 724 (backfill)

**Files:**
- Create: `supabase/migrations/723_move_whatsapp_conversation.sql`
- Create: `supabase/migrations/724_wa_home_studio_backfill.sql`
- Test: `tests/migration-723-724-wa-home-studio.test.js`

**Interfaces:**
- Produces: `public.move_whatsapp_conversation(p_conversation_id uuid, p_target_location_id uuid) RETURNS jsonb` → `{ conversation_id, merged, from_location_id, to_location_id }`. Raises `conversation_not_found` (P0002), `same_studio` (22023), `other_organisation` (22023). Called by Task 8 via `db.rpc('move_whatsapp_conversation', { p_conversation_id, p_target_location_id })`.

- [ ] **Step 1: Write the failing PGlite test**

```js
// WAHOMESTUDIO.1 — behavioural test for migrations 723 (move/merge function)
// and 724 (backfill). Models the live columns (information_schema, 15 Oct
// 2026) of the tables the function touches and runs the REAL files.
// Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_723 = read('723_move_whatsapp_conversation.sql')
const MIG_724 = read('724_wa_home_studio_backfill.sql')

const ORG = 'd0000000-0000-0000-0000-000000000001'
const ORG2 = 'd0000000-0000-0000-0000-000000000002'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const OTHER = 'a0000000-0000-0000-0000-000000000003'
const NUM = 'f0000000-0000-0000-0000-000000000001'
const K_HATCH = 'b0000000-0000-0000-0000-000000000001'
const K_STILL = 'b0000000-0000-0000-0000-000000000002'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const C2 = 'c0000000-0000-0000-0000-000000000002'
const C3 = 'c0000000-0000-0000-0000-000000000003'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid NOT NULL);
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY, location_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, wa_phone text, status text DEFAULT 'active',
    window_expires_at timestamptz, last_message_at timestamptz, last_message_direction text, last_message_preview text,
    unread_count integer DEFAULT 0, assigned_to uuid, resolved_at timestamptz,
    whatsapp_number_id uuid REFERENCES public.whatsapp_numbers(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (location_id, wa_phone));
  CREATE TABLE public.whatsapp_messages (id serial PRIMARY KEY,
    conversation_id uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE, location_id uuid, body text);
  CREATE TABLE public.agent_decisions (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_membership_requests (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_message_feedback (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_conversation_reviews (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid,
    review_date date, UNIQUE (channel, conversation_id, review_date));
  INSERT INTO public.locations VALUES ('${STILL}', '${ORG}'), ('${HATCH}', '${ORG}'), ('${OTHER}', '${ORG2}');
  INSERT INTO public.whatsapp_numbers (id, location_id, is_default) VALUES ('${NUM}', '${STILL}', true);
  INSERT INTO public.contacts VALUES ('${K_HATCH}', '${HATCH}'), ('${K_STILL}', '${STILL}');
`
async function boot(extra = '') {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (extra) await db.exec(extra)
  await db.exec(MIG_723)
  return db
}
const one = async (db, sql) => (await db.query(sql)).rows[0]
const move = (db, conv, loc) => one(db, `SELECT public.move_whatsapp_conversation('${conv}', '${loc}') AS r`).then((x) => x.r)

const HATCH_THREAD_AT_STILL = `
  INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, unread_count, last_message_at, last_message_preview)
    VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100', 2, '2026-10-01T10:00Z', 'old');
  INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES ('${C1}', '${STILL}', 'hi'), ('${C1}', '${STILL}', 'there');
  INSERT INTO public.agent_decisions (channel, conversation_id, location_id) VALUES ('whatsapp', '${C1}', '${STILL}');
  INSERT INTO public.agent_conversation_reviews (channel, conversation_id, location_id, review_date) VALUES ('whatsapp', '${C1}', '${STILL}', '2026-10-01');
`

describe('723 move_whatsapp_conversation', () => {
  it('re-files a thread with its messages and agent rows, and stamps the source studio’s default number', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL)
    const r = await move(db, C1, HATCH)
    expect(r).toEqual({ conversation_id: C1, merged: false, from_location_id: STILL, to_location_id: HATCH })
    expect(await one(db, `SELECT location_id, whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C1}'`))
      .toEqual({ location_id: HATCH, whatsapp_number_id: NUM })
    expect((await db.query(`SELECT DISTINCT location_id FROM whatsapp_messages`)).rows).toEqual([{ location_id: HATCH }])
    expect(await one(db, `SELECT location_id FROM agent_decisions`)).toEqual({ location_id: HATCH })
    expect(await one(db, `SELECT location_id FROM agent_conversation_reviews`)).toEqual({ location_id: HATCH })
  })

  it('merges into an existing thread at the target: messages re-pointed, newest preview kept, unread summed, source deleted', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, unread_count, last_message_at, last_message_preview)
        VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100', 1, '2026-10-05T10:00Z', 'new');
      INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES ('${C2}', '${HATCH}', 'later');
      INSERT INTO public.agent_conversation_reviews (channel, conversation_id, location_id, review_date) VALUES ('whatsapp', '${C2}', '${HATCH}', '2026-10-01');
    `)
    const r = await move(db, C1, HATCH)
    expect(r).toMatchObject({ conversation_id: C2, merged: true })
    expect(await one(db, `SELECT count(*)::int AS n FROM whatsapp_conversations`)).toEqual({ n: 1 })
    expect(await one(db, `SELECT count(*)::int AS n FROM whatsapp_messages WHERE conversation_id = '${C2}' AND location_id = '${HATCH}'`)).toEqual({ n: 3 })
    expect(await one(db, `SELECT unread_count, last_message_preview, whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C2}'`))
      .toEqual({ unread_count: 3, last_message_preview: 'new', whatsapp_number_id: NUM })
    // Review Focus 2: the same-day review clash keeps the target's row.
    expect((await db.query(`SELECT conversation_id FROM agent_conversation_reviews`)).rows).toEqual([{ conversation_id: C2 }])
    expect(await one(db, `SELECT conversation_id, location_id FROM agent_decisions`)).toEqual({ conversation_id: C2, location_id: HATCH })
  })

  it('refuses another organisation and its own studio, writing nothing (Review Focus 5)', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL)
    await expect(move(db, C1, OTHER)).rejects.toThrow(/other_organisation/)
    await expect(move(db, C1, STILL)).rejects.toThrow(/same_studio/)
    await expect(move(db, C3, HATCH)).rejects.toThrow(/conversation_not_found/)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: STILL })
  })

  it('is executable by service_role only', async () => {
    const db = await boot()
    const acl = await one(db, `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'move_whatsapp_conversation'`)
    expect(acl.acl).toContain('service_role=X')
    expect(acl.acl).not.toMatch(/(^|[{,])=X/)        // no PUBLIC
    expect(acl.acl).not.toMatch(/(anon|authenticated)=X/)
  })
})

describe('724 backfill', () => {
  it('moves only threads of contacts whose home is a number-less same-org sibling; a second run is a no-op', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C3}', '${STILL}', '${K_STILL}', '15555550101');
    `)
    await db.exec(MIG_724)
    expect((await db.query(`SELECT id, location_id FROM whatsapp_conversations ORDER BY id`)).rows)
      .toEqual([{ id: C1, location_id: HATCH }, { id: C3, location_id: STILL }])
    await db.exec(MIG_724)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: HATCH })
  })

  it('leaves a contact whose home studio has its own active number alone', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_numbers (id, location_id, is_default) VALUES ('f0000000-0000-0000-0000-000000000002', '${HATCH}', true);
    `)
    await db.exec(MIG_724)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: STILL })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migration-723-724-wa-home-studio.test.js`
Expected: FAIL — `ENOENT … 723_move_whatsapp_conversation.sql`.

- [ ] **Step 3: Write migration 723**

```sql
-- 723_move_whatsapp_conversation.sql
-- WAHOMESTUDIO.1 — re-file (or merge) a WhatsApp thread at another studio of
-- the SAME organisation. Phase 1 of "Mia at organisation level"
-- (docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md, R7).
--
-- Used by mig 724 (the one-off backfill of threads WANUMBERLESS.1 filed at the
-- receiving studio) and by POST /api/whatsapp/conversations/[id]/move.
--   * target in another organisation, or the thread's own studio → refused;
--   * no thread at the target for this wa_phone → the row is re-filed;
--   * one exists → MERGED into it: messages re-pointed, target row kept
--     (newest last_message_*, summed unread), the emptied source deleted;
--   * whatsapp_messages.location_id and the channel='whatsapp' rows of the four
--     agent tables follow the thread (a same-day review clash keeps the
--     target's review);
--   * a thread with no number stamp gets the SOURCE studio's default number,
--     the number it was talking through (getConversationNumberConfig, R4).
-- SECURITY INVOKER: only service_role may execute it (mig 667 rule), and
-- service_role bypasses RLS.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.move_whatsapp_conversation(p_conversation_id uuid, p_target_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.whatsapp_conversations%ROWTYPE;
  v_source_org uuid;
  v_target_org uuid;
  v_target_id uuid;
  v_stamp uuid;
  v_merged boolean := false;
BEGIN
  SELECT * INTO v_conv FROM public.whatsapp_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_conv.location_id = p_target_location_id THEN
    RAISE EXCEPTION 'same_studio' USING ERRCODE = '22023';
  END IF;
  SELECT organization_id INTO v_source_org FROM public.locations WHERE id = v_conv.location_id;
  SELECT organization_id INTO v_target_org FROM public.locations WHERE id = p_target_location_id;
  IF v_target_org IS NULL OR v_source_org IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'other_organisation' USING ERRCODE = '22023';
  END IF;

  v_stamp := COALESCE(v_conv.whatsapp_number_id, (
    SELECT n.id FROM public.whatsapp_numbers n
     WHERE n.location_id = v_conv.location_id AND n.is_active
     ORDER BY n.is_default DESC, n.updated_at DESC
     LIMIT 1));

  SELECT id INTO v_target_id FROM public.whatsapp_conversations
   WHERE location_id = p_target_location_id AND wa_phone IS NOT DISTINCT FROM v_conv.wa_phone
   FOR UPDATE;

  IF v_target_id IS NULL THEN
    UPDATE public.whatsapp_conversations
       SET location_id = p_target_location_id, whatsapp_number_id = v_stamp
     WHERE id = v_conv.id;
    v_target_id := v_conv.id;
  ELSE
    v_merged := true;
    UPDATE public.whatsapp_messages SET conversation_id = v_target_id WHERE conversation_id = v_conv.id;
    UPDATE public.whatsapp_conversations t SET
      contact_id = COALESCE(t.contact_id, v_conv.contact_id),
      unread_count = COALESCE(t.unread_count, 0) + COALESCE(v_conv.unread_count, 0),
      window_expires_at = GREATEST(t.window_expires_at, v_conv.window_expires_at),
      last_message_direction = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_direction ELSE t.last_message_direction END,
      last_message_preview = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_preview ELSE t.last_message_preview END,
      last_message_at = GREATEST(t.last_message_at, v_conv.last_message_at),
      whatsapp_number_id = COALESCE(t.whatsapp_number_id, v_stamp)
     WHERE t.id = v_target_id;
    DELETE FROM public.agent_conversation_reviews s
     WHERE s.channel = 'whatsapp' AND s.conversation_id = v_conv.id
       AND EXISTS (SELECT 1 FROM public.agent_conversation_reviews t
                    WHERE t.channel = 'whatsapp' AND t.conversation_id = v_target_id AND t.review_date = s.review_date);
  END IF;

  UPDATE public.whatsapp_messages SET location_id = p_target_location_id
   WHERE conversation_id = v_target_id AND location_id IS DISTINCT FROM p_target_location_id;
  UPDATE public.agent_decisions SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_membership_requests SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_message_feedback SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_conversation_reviews SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;

  IF v_merged THEN
    DELETE FROM public.whatsapp_conversations WHERE id = v_conv.id;
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_target_id, 'merged', v_merged,
    'from_location_id', v_conv.location_id, 'to_location_id', p_target_location_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.move_whatsapp_conversation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_whatsapp_conversation(uuid, uuid) TO service_role;

COMMIT;
```

- [ ] **Step 4: Write migration 724**

```sql
-- 724_wa_home_studio_backfill.sql
-- WAHOMESTUDIO.1 — one-off: re-file every WhatsApp thread whose contact's
-- home studio is a NUMBER-LESS sibling (same organisation) of the thread's
-- studio, through move_whatsapp_conversation (mig 723). These are the threads
-- WANUMBERLESS.1 (#1940) and sending-studio outbound filed at the receiving
-- studio (~120 Hatch Street threads in the Stillorgan inbox, 15 Oct 2026).
-- Apply RIGHT AFTER the WAHOMESTUDIO.1 code deploys (spec §5): before it, a
-- thread at Hatch cannot be answered. Idempotent: a second run finds nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r record;
  v_res jsonb;
  v_moved int := 0;
  v_merged int := 0;
BEGIN
  FOR r IN
    SELECT c.id, k.location_id AS home
      FROM public.whatsapp_conversations c
      JOIN public.contacts k ON k.id = c.contact_id
      JOIN public.locations lc ON lc.id = c.location_id
      JOIN public.locations lh ON lh.id = k.location_id
     WHERE k.location_id <> c.location_id
       AND lh.organization_id = lc.organization_id
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_numbers n WHERE n.location_id = k.location_id AND n.is_active)
     ORDER BY c.created_at, c.id
  LOOP
    v_res := public.move_whatsapp_conversation(r.id, r.home);
    IF (v_res->>'merged')::boolean THEN v_merged := v_merged + 1; ELSE v_moved := v_moved + 1; END IF;
  END LOOP;
  RAISE NOTICE 'WAHOMESTUDIO.1 backfill: % moved, % merged', v_moved, v_merged;
END $$;

COMMIT;
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/migration-723-724-wa-home-studio.test.js`
Expected: PASS (7 tests). If the ACL assertion fails on PGlite's text format, print `proacl` and adjust only the regex, not the grants.

- [ ] **Step 6: Run the migration gates**

Run: `npm run check:rpc-names && npx vitest run tests/function-execute-guard.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/723_move_whatsapp_conversation.sql supabase/migrations/724_wa_home_studio_backfill.sql tests/migration-723-724-wa-home-studio.test.js
git commit -m "WAHOMESTUDIO.1 — migs 723/724: move/merge a WhatsApp thread within an organisation + backfill"
```

---

### Task 2: Reply number from a same-organisation sibling (R4) + template studio (R5 resolver half)

**Files:**
- Modify: `src/lib/whatsapp-config.js` (`getConversationReplyConfig` ~l.132, `getConversationNumberConfig` ~l.155)
- Test: `src/lib/whatsapp-reply-number.test.js`
- Modify: `tests/whatsapp-config-callers.test.js` (RESOLVING for `src/lib/whatsapp-config` gains `templateLocationIdFor`; `src/lib/whatsapp.js` row `why` text)

**Interfaces:**
- Produces: `getConversationNumberConfig(locationId, conversationId) → Promise<config|null>` (now may return a config whose `.locationId !== locationId`); `templateLocationIdFor(locationId, conversationId) → Promise<string>` (the studio whose templates this thread sends: the stamped number's owner when it is a sibling, else `locationId`; never throws).

- [ ] **Step 1: Extend the fake DB and add failing tests** in `src/lib/whatsapp-reply-number.test.js`

In the `vi.mock('./supabase', …)` builder add `locations` as a source and an `in` filter:

```js
// state gains: locations: []
const src = table === 'whatsapp_conversations' ? state.conversations
  : table === 'whatsapp_numbers' ? state.numbers
  : table === 'locations' ? state.locations : []
// builder gains:
in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return b },
```

In `beforeEach`: `state.locations = [{ id: LOC, organization_id: 'ORG-1' }, { id: LOC2, organization_id: 'ORG-1' }, { id: LOC3, organization_id: 'ORG-2' }]` with `const LOC3 = 'a0000000-0000-4000-8000-000000000003'`.

Add:

```js
describe('WAHOMESTUDIO.1 — a number-less studio replies through a same-organisation sibling’s number', () => {
  // LOC owns DEFAULT and SECOND; LOC2 owns nothing.
  const hatchConv = (stamp) => conv(stamp, { location_id: LOC2 })

  it('a thread at a number-less studio stamped with a sibling’s number replies from it, templates too', async () => {
    state.conversations = [hatchConv('n-default')]
    expect((await getConversationReplyConfig(LOC2, CONV)).phoneNumberId).toBe('PNI-n-default')
    expect((await getConversationReplyConfig(LOC2, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('a sibling stamp is ignored once the thread’s studio has a number of its own (Review Focus 1)', async () => {
    state.numbers = [DEFAULT, num('n-hatch', { location_id: LOC2, is_default: true })]
    state.conversations = [hatchConv('n-default')]
    expect((await getConversationReplyConfig(LOC2, CONV)).phoneNumberId).toBe('PNI-n-hatch')
  })

  it('a number in ANOTHER organisation is never used; the number-less studio still refuses', async () => {
    state.numbers = [num('n-foreign', { location_id: LOC3, is_default: true })]
    state.conversations = [hatchConv('n-foreign')]
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    await expect(getConversationReplyConfig(LOC2, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
  })

  it('an unreadable locations row is null (no sibling number), logged', async () => {
    state.conversations = [hatchConv('n-default')]
    state.faults.locations = { message: 'boom' }
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('templateLocationIdFor names the number owner for a sibling stamp, else the thread’s studio', async () => {
    const { templateLocationIdFor } = await import('./whatsapp-config.js')
    state.conversations = [hatchConv('n-default')]
    expect(await templateLocationIdFor(LOC2, CONV)).toBe(LOC)
    state.conversations = [conv('n-second')]
    expect(await templateLocationIdFor(LOC, CONV)).toBe(LOC)
    expect(await templateLocationIdFor(LOC2, null)).toBe(LOC2)
  })
})
```

Keep the existing test `'a recorded number at ANOTHER studio is never used'` unchanged (LOC has numbers of its own, so R4(b) does not apply). Update the file header comment's sentence "when it is still an active row AT the conversation's studio" to add "or, at a studio with no number of its own, a same-organisation sibling's (WAHOMESTUDIO.1)".

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/whatsapp-reply-number.test.js`
Expected: FAIL — the sibling tests get `PNI-…` mismatches / `templateLocationIdFor is not a function`.

- [ ] **Step 3: Implement** in `src/lib/whatsapp-config.js`

Replace `getConversationReplyConfig`'s body:

```js
export async function getConversationReplyConfig(locationId, conversationId, { template = false } = {}) {
  const thread = await getConversationNumberConfig(locationId, conversationId)
  if (!thread) return getWhatsAppConfig(locationId)
  if (!template) return thread
  // WAHOMESTUDIO.1 — a sibling's number only reaches here for a studio with no
  // number of its own, so there is no default to compare WABAs with: the
  // template comes from the number owner's WABA (templateLocationIdFor).
  if (thread.locationId !== locationId) return thread
  return pickReplyConfig(thread, await getWhatsAppConfig(locationId), { template: true })
}
```

Replace the number read inside `getConversationNumberConfig` (from `const { data: num, error: numErr } = …` to `return num ? rowToConfig(num) : null`):

```js
    const { data: num, error: numErr } = await db.from('whatsapp_numbers')
      .select('*')
      .eq('id', conv.whatsapp_number_id)
      .eq('is_active', true)
      .maybeSingle()
    if (numErr) throw numErr
    if (!num) return null
    if (num.location_id === locationId) return rowToConfig(num)
    // WAHOMESTUDIO.1 (R4) — a SIBLING studio's number: only for a thread at a
    // studio with no active number of its own, and only inside one
    // organisation. The thread is filed at the customer's own studio, so a
    // reply from the organisation number cannot land in another studio's
    // inbox (the harm WACONFIGFALLBACK.1 closed).
    const { data: own, error: ownErr } = await db.from('whatsapp_numbers')
      .select('id')
      .eq('location_id', locationId)
      .eq('is_active', true)
      .limit(1)
    if (ownErr) throw ownErr
    if (own && own.length > 0) return null
    const { data: locs, error: locErr } = await db.from('locations')
      .select('id, organization_id')
      .in('id', [locationId, num.location_id])
    if (locErr) throw locErr
    const orgOf = (id) => (locs || []).find((l) => l.id === id)?.organization_id || null
    const threadOrg = orgOf(locationId)
    if (!threadOrg || threadOrg !== orgOf(num.location_id)) return null
    return rowToConfig(num)
```

Update its JSDoc first line to: "the number recorded on the thread while it is an ACTIVE row at this location, or (WAHOMESTUDIO.1) a same-organisation sibling's when this location has no active number; null otherwise."

Add after `getConversationNumberConfig`:

```js
/**
 * WAHOMESTUDIO.1 (R5) — the studio whose whatsapp_templates a send in this
 * thread uses: templates are synced per studio from that studio's default
 * number's WABA, so a thread replying through a sibling's number sends that
 * sibling's templates. Never throws (getConversationNumberConfig never does).
 */
export async function templateLocationIdFor(locationId, conversationId) {
  const thread = await getConversationNumberConfig(locationId, conversationId)
  return thread?.locationId || locationId
}
```

- [ ] **Step 4: Update the callers table** (`tests/whatsapp-config-callers.test.js`)

Add `'templateLocationIdFor'` to `RESOLVING['src/lib/whatsapp-config']`. In the `src/lib/whatsapp.js` row's `why`, after "refuses a number-less studio the same way" insert: "unless the thread carries a same-organisation sibling's stamp (WAHOMESTUDIO.1 R4)". Callers of `templateLocationIdFor` are added in Task 7.

- [ ] **Step 5: Run**

Run: `npx vitest run src/lib/whatsapp-reply-number.test.js tests/whatsapp-config-callers.test.js src/lib/whatsapp-no-number-senders.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-config.js src/lib/whatsapp-reply-number.test.js tests/whatsapp-config-callers.test.js
git commit -m "WAHOMESTUDIO.1 — a number-less studio's thread replies through a same-org sibling's stamped number"
```

---

### Task 3: `numberlessHomeStudio` (R1)

**Files:**
- Create: `src/lib/whatsapp-thread-location.js`
- Test: `src/lib/whatsapp-thread-location.test.js`

**Interfaces:**
- Produces: `numberlessHomeStudio(db, contact, numberLocationId) → Promise<string|null>`; `contact` is `{ id?, location_id? }`. Returns the contact's home `location_id` when it differs from `numberLocationId`, both studios share an organisation, and home has no active `whatsapp_numbers` row; else `null`. Never throws (logs `logWarn('wa-thread-location', …)`).

- [ ] **Step 1: Write the failing test**

```js
// WAHOMESTUDIO.1 (R1) — where a thread for a contact belongs when it is opened
// on another studio's number. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
import { numberlessHomeStudio } from './whatsapp-thread-location.js'
import { logWarn } from './log'

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const OTHER = 'a0000000-0000-4000-8000-000000000003'

function makeDb(state) {
  return {
    from: (table) => {
      const filters = []
      const run = () => {
        if (state.faults?.[table]) return { data: null, error: state.faults[table] }
        const rows = (state[table] || []).filter((r) => filters.every((f) => f(r)))
        return { data: rows, error: null }
      }
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return b },
        limit: () => b,
        maybeSingle: async () => { const o = run(); return o.error ? o : { data: o.data[0] ?? null, error: null } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

let state
beforeEach(() => {
  vi.clearAllMocks()
  state = {
    locations: [{ id: STILL, organization_id: 'O1' }, { id: HATCH, organization_id: 'O1' }, { id: OTHER, organization_id: 'O2' }],
    whatsapp_numbers: [{ id: 'n1', location_id: STILL, is_active: true }],
    contacts: [{ id: 'k1', location_id: HATCH }],
  }
})

describe('numberlessHomeStudio', () => {
  it('a home studio with no number, same organisation → the home studio', async () => {
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBe(HATCH)
  })
  it('reads the contact’s studio when the row carries no location_id (Review Focus 4)', async () => {
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1' }, STILL)).toBe(HATCH)
  })
  it('home has its own active number → null', async () => {
    state.whatsapp_numbers.push({ id: 'n2', location_id: HATCH, is_active: true })
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBeNull()
  })
  it('an inactive home number does not count as a number', async () => {
    state.whatsapp_numbers.push({ id: 'n2', location_id: HATCH, is_active: false })
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBe(HATCH)
  })
  it('another organisation, the same studio, no contact, or no studio → null', async () => {
    const db = makeDb(state)
    expect(await numberlessHomeStudio(db, { id: 'k9', location_id: OTHER }, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, { id: 'k1', location_id: STILL }, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, null, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, { id: 'k1', location_id: HATCH }, null)).toBeNull()
  })
  it('a failed read → null, logged (files where it does today)', async () => {
    state.faults = { whatsapp_numbers: { message: 'boom' } }
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('wa-thread-location', 'home studio lookup failed; filing at the number’s studio', expect.objectContaining({ err: 'boom' }))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/whatsapp-thread-location.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```js
// WAHOMESTUDIO.1 (R1) — where a WhatsApp thread for a contact belongs when it
// is opened on another studio's number (an outbound send, a coexistence echo).
//
// A contact whose home studio has no WhatsApp number of its own, in the SAME
// organisation as the number's studio, gets the thread at their home studio:
// Hatch Street's customers sit in the Hatch inbox, and replies go through the
// organisation number stamped on the thread (getConversationNumberConfig, R4).
// Anything else — a home studio with its own number, another organisation, no
// contact, a failed read — returns null and the caller files where it always
// has. Spec: docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md
import { logWarn } from './log'

export async function numberlessHomeStudio(db, contact, numberLocationId) {
  if (!contact || !numberLocationId) return null
  try {
    let home = contact.location_id
    if (home === undefined && contact.id) {
      const { data, error } = await db.from('contacts').select('location_id').eq('id', contact.id).maybeSingle()
      if (error) throw error
      home = data?.location_id
    }
    if (!home || home === numberLocationId) return null

    const { data: own, error: ownErr } = await db.from('whatsapp_numbers')
      .select('id').eq('location_id', home).eq('is_active', true).limit(1)
    if (ownErr) throw ownErr
    if (own && own.length > 0) return null

    const { data: locs, error: locErr } = await db.from('locations')
      .select('id, organization_id').in('id', [home, numberLocationId])
    if (locErr) throw locErr
    const orgOf = (id) => (locs || []).find((l) => l.id === id)?.organization_id || null
    const homeOrg = orgOf(home)
    return homeOrg && homeOrg === orgOf(numberLocationId) ? home : null
  } catch (e) {
    logWarn('wa-thread-location', 'home studio lookup failed; filing at the number’s studio', {
      contactId: contact.id || null, numberLocationId, err: e?.message || String(e),
    })
    return null
  }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/whatsapp-thread-location.test.js && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-thread-location.js src/lib/whatsapp-thread-location.test.js
git commit -m "WAHOMESTUDIO.1 — numberlessHomeStudio: the filing rule for threads opened on a sibling's number"
```

---

### Task 4: Outbound threads open at the home studio (`getOrCreateConversation`, R1 + R3)

**Files:**
- Modify: `src/lib/whatsapp.js:2075` (`getOrCreateConversation`)
- Test: `src/lib/whatsapp-get-or-create-conversation.test.js` (create)

**Interfaces:**
- Consumes: `numberlessHomeStudio` (Task 3).
- Produces: `getOrCreateConversation(db, contact, locationId) → Promise<string|undefined>` unchanged signature; a NEW thread for a numberless-home contact is created at the home studio and stamped with the sending studio's default active number id.

- [ ] **Step 1: Write the failing test**

```js
// WAHOMESTUDIO.1 — an outbound send (broadcast, sequence, any send that opens a
// thread) to a contact whose home studio has no number files the thread at the
// home studio, stamped with the sending studio's number, so their reply lands
// in the same thread (the webhook files there too). Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./whatsapp-thread-location', () => ({ numberlessHomeStudio: vi.fn(async () => null) }))
const { getOrCreateConversation } = await import('./whatsapp.js')
const { numberlessHomeStudio } = await import('./whatsapp-thread-location')

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'

function makeDb(state) {
  const writes = []
  const from = (table) => {
    const filters = []
    let op = 'select'
    let payload = null
    const run = () => {
      if (op === 'insert') {
        const row = { id: `conv-${state.whatsapp_conversations.length + 1}`, ...payload }
        state.whatsapp_conversations.push(row)
        writes.push({ table, op, payload })
        return { data: { id: row.id }, error: null }
      }
      if (op === 'update') { writes.push({ table, op, payload }); return { data: null, error: null } }
      const rows = (state[table] || []).filter((r) => filters.every((f) => f(r)))
      return { data: rows, error: null }
    }
    const b = {
      select: () => b,
      insert: (p) => { op = 'insert'; payload = p; return b },
      update: (p) => { op = 'update'; payload = p; return b },
      eq: (c, v) => { filters.push((r) => r[c] === v); return b },
      order: () => b,
      limit: () => b,
      single: async () => { const o = run(); return { data: Array.isArray(o.data) ? o.data[0] ?? null : o.data, error: o.error } },
      maybeSingle: async () => { const o = run(); return { data: Array.isArray(o.data) ? o.data[0] ?? null : o.data, error: o.error } },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, writes }
}

let state
beforeEach(() => {
  vi.clearAllMocks()
  state = {
    whatsapp_conversations: [],
    whatsapp_numbers: [{ id: 'n-still', location_id: STILL, is_active: true, is_default: true }],
  }
})

describe('getOrCreateConversation — WAHOMESTUDIO.1', () => {
  it('a numberless-home contact gets a new thread at the home studio, stamped with the sender’s number', async () => {
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    const db = makeDb(state)
    const id = await getOrCreateConversation(db, { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
    expect(state.whatsapp_conversations[0]).toMatchObject({ id, location_id: HATCH, contact_id: 'k1', whatsapp_number_id: 'n-still' })
    expect(numberlessHomeStudio).toHaveBeenCalledWith(db, { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
  })

  it('reuses the home studio’s existing thread', async () => {
    state.whatsapp_conversations.push({ id: 'conv-hatch', location_id: HATCH, wa_phone: '15555550100', contact_id: 'k1' })
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    expect(await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100' }, STILL)).toBe('conv-hatch')
  })

  it('an existing thread at the sending studio is still reused, with no home lookup', async () => {
    state.whatsapp_conversations.push({ id: 'conv-still', location_id: STILL, wa_phone: '15555550100', contact_id: 'k1' })
    expect(await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)).toBe('conv-still')
    expect(numberlessHomeStudio).not.toHaveBeenCalled()
  })

  it('any other contact: a new thread at the sending studio, no stamp written by this path', async () => {
    await getOrCreateConversation(makeDb(state), { id: 'k2', wa_phone: '15555550101', location_id: STILL }, STILL)
    expect(state.whatsapp_conversations[0]).toMatchObject({ location_id: STILL })
    expect(state.whatsapp_conversations[0]).not.toHaveProperty('whatsapp_number_id')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/whatsapp-get-or-create-conversation.test.js`
Expected: FAIL — first test gets `location_id: STILL`.

- [ ] **Step 3: Implement.** In `src/lib/whatsapp.js` add `import { numberlessHomeStudio } from './whatsapp-thread-location'` with the other imports, then restructure the `if (waPhone) { … }` block of `getOrCreateConversation`:

```js
  const waPhone = contact.wa_phone
  if (waPhone) {
    const findAt = async (loc) => {
      const { data } = await db.from('whatsapp_conversations')
        .select('id, contact_id')
        .eq('location_id', loc)
        .eq('wa_phone', waPhone)
        .maybeSingle()
      return data
    }
    const linkContact = async (row) => {
      // Backfill contact_id if the row was created for an unknown sender.
      if (!row.contact_id && contact.id) {
        await db.from('whatsapp_conversations').update({ contact_id: contact.id }).eq('id', row.id)
      }
      return row.id
    }

    const existing = await findAt(locationId)
    if (existing) return linkContact(existing)

    // WAHOMESTUDIO.1 (R1) — a contact whose home studio has no WhatsApp number
    // of its own (same organisation) gets the thread at their home studio, the
    // same place the webhook files their reply, stamped with the sending
    // studio's number so replies resolve it (R3/R4). Only on a NEW thread: an
    // existing one at the sending studio is the backfill's (mig 724) to move.
    const home = await numberlessHomeStudio(db, contact, locationId)
    let fileAt = locationId
    let stamp = null
    if (home) {
      const atHome = await findAt(home)
      if (atHome) return linkContact(atHome)
      fileAt = home
      const { data: num } = await db.from('whatsapp_numbers')
        .select('id')
        .eq('location_id', locationId)
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      stamp = num?.id || null
    }

    const { data: created, error } = await db.from('whatsapp_conversations').insert({
      location_id: fileAt,
      contact_id: contact.id,
      wa_phone: waPhone,
      status: 'active',
      ...(stamp ? { whatsapp_number_id: stamp } : {}),
    }).select('id').single()
    if (!error && created) return created.id

    // Lost a race with the inbound webhook (or another send) on the same
    // wa_phone — the unique constraint rejected us; re-read the winner.
    const raced = await findAt(fileAt)
    return raced?.id
  }
```

Leave the no-`wa_phone` branch below unchanged.

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/whatsapp-get-or-create-conversation.test.js src/lib/whatsapp-no-number-broadcasts.test.js && npx vitest run src/lib/sequences src/lib/radar-outreach-takeover.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-get-or-create-conversation.test.js
git commit -m "WAHOMESTUDIO.1 — outbound opens a numberless-home contact's thread at their home studio"
```

---

### Task 5: Webhook files at the contact's home studio (R2, R3) + coexistence (R1)

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (l.~291-313 location resolution; l.~368 stamp; l.~526 media rehost object; l.~824 coexistence call)
- Modify: `src/lib/whatsapp-coexistence-ingest.js` (`ingestCoexistenceMessage`)
- Test: `src/app/api/webhooks/whatsapp/route.reply-number.test.js`, `src/lib/whatsapp-coexistence-ingest.test.js`
- Modify: `tests/whatsapp-config-callers.test.js` (webhook row `why`)

**Interfaces:**
- Consumes: `numberlessHomeStudio` (Task 3).
- Produces: `ingestCoexistenceMessage(db, { locationId, numberId?, descriptor })` — `numberId` optional (the receiving number's `whatsapp_numbers.id`), stamped on a thread it files at a numberless home studio. The rehost object gains `conversation_id` (used by Task 6).

- [ ] **Step 1: Rewrite the WANUMBERLESS.1 tests** in `route.reply-number.test.js`

Replace the three tests `'a contact filed at a studio with NO WhatsApp number …'`, `'a failed number lookup for the contact’s studio …'` and keep `'a contact filed at ANOTHER studio that has its own number …'`. New ones:

```js
  // WAHOMESTUDIO.1 (R2/R3) — the thread lives at the contact's own studio even
  // when it has no number; replies go through the receiving number stamped on
  // it (a same-organisation sibling's, getConversationNumberConfig R4).
  it('a contact filed at a studio with NO WhatsApp number gets the thread AT that studio, stamped with the receiving number', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const lookup = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'select'))
    expect(lookup.ops).toContainEqual(['eq', 'location_id', 'loc-hatch'])
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch', contact_id: 'contact-9' })
    const msgInsert = db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))
    expect(msgInsert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch' }))
    expect(stamps().map((c) => c.ops)).toEqual([[['update', { whatsapp_number_id: 'wn-1' }], ['eq', 'id', 'conv-1']]])
  })

  it('a failed number lookup for the contact’s studio still files there and stamps (the stamp is inert where a number exists), logged', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockRejectedValueOnce(new Error('Failed to load WhatsApp config for location loc-hatch: boom'))
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
    expect(stamps()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledWith(
      '[wa-webhook] WhatsApp number lookup for location loc-hatch failed (thread stamped with the receiving number):',
      'Failed to load WhatsApp config for location loc-hatch: boom',
    )
  })

  it('an unknown sender still files at the receiving studio, stamped', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still', contact_id: null })
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })
```

Update the file header: replace "It is written only when the receiving number belongs to the conversation's studio (a contact filed at another studio keeps that studio's thread, which replies from its own default)." with "It is written when the receiving number belongs to the conversation's studio, or the conversation's studio has no number of its own (WAHOMESTUDIO.1); a contact filed at another studio WITH a number keeps that studio's thread, which replies from its own default." Also change the `getLocationWhatsAppNumberConfig` mock comment to "the contact's own studio's number; null = no number there (WAHOMESTUDIO.1: decides the stamp only)".

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/webhooks/whatsapp/route.reply-number.test.js`
Expected: FAIL — threads filed at `loc-still`.

- [ ] **Step 3: Implement the webhook.** Replace the comment block + code from `// Determine location: contact's location wins …` through the closing `}` of `if (locationId !== defaultLocationId) { … }` with:

```js
  // Determine location: the contact's own studio if known (their CRM
  // placement; the match above is organisation-fenced), otherwise the
  // WA-number owner.
  //
  // WAHOMESTUDIO.1 (R2) — even when that studio has no WhatsApp number of its
  // own: the thread sits in the customer's own inbox (Hatch Street's in the
  // Hatch inbox, Mia judged on Hatch's settings) and replies go through the
  // receiving number stamped below (getConversationNumberConfig, R4). This
  // replaces WANUMBERLESS.1, which filed such threads at the receiving studio.
  const locationId = contact?.location_id || defaultLocationId

  // R3 — stamp the receiving number when the thread is at its studio (as
  // ever), or when the thread's studio has none of its own. A failed lookup
  // stamps too: the resolver ignores a sibling's stamp wherever the studio
  // has a number, so it can only help.
  let stampReceivingNumber = locationId === defaultLocationId
  if (!stampReceivingNumber) {
    try {
      stampReceivingNumber = !(await getLocationWhatsAppNumberConfig(locationId))
    } catch (e) {
      console.error(`[wa-webhook] WhatsApp number lookup for location ${locationId} failed (thread stamped with the receiving number):`, e?.message || String(e))
      stampReceivingNumber = true
    }
  }
```

Change the stamp condition `if (receivingNumberId && locationId === defaultLocationId) {` to `if (receivingNumberId && stampReceivingNumber) {` and in its comment replace "Only when that number belongs to the thread's studio: a contact filed at another studio keeps that studio's thread, which replies from its own number." with "When that number belongs to the thread's studio, or the thread's studio has no number (WAHOMESTUDIO.1 R3); a contact filed at a studio WITH a number keeps that studio's thread, which replies from its own number."

In the `ensureMediaRehosted(db, { … })` object add `conversation_id: conversationId,` after `location_id: locationId,`.

At l.~824 change `ingestCoexistenceMessage(db, { locationId, descriptor: d })` to `ingestCoexistenceMessage(db, { locationId, numberId: routing.numberId, descriptor: d })` (confirm `routing` is in scope there; if the coexistence branch uses another variable for the classified owner, pass that one's `numberId`).

- [ ] **Step 4: Coexistence test (failing).** Add to `src/lib/whatsapp-coexistence-ingest.test.js` (reuse its db stub; add `vi.mock('./whatsapp-thread-location', () => ({ numberlessHomeStudio: vi.fn(async () => null) }))` at the top if absent):

```js
it('WAHOMESTUDIO.1 — a peer whose home studio has no number threads at that studio, stamped with the receiving number', async () => {
  numberlessHomeStudio.mockResolvedValueOnce('loc-hatch')
  // stub: contacts match → { id: 'k1', location_id: 'loc-hatch' }; no conversation at loc-hatch yet
  await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: { ...ECHO } })
  expect(conversationInsert()).toMatchObject({ location_id: 'loc-hatch', contact_id: 'k1', whatsapp_number_id: 'wn-1' })
  expect(messageInsert()).toMatchObject({ location_id: 'loc-hatch' })
})
```

Adapt `db`, `ECHO`, `conversationInsert()` and `messageInsert()` to the helpers that file already defines (read its top 60 lines first; name the fixture the file uses for an echo descriptor).

- [ ] **Step 5: Implement coexistence.** In `ingestCoexistenceMessage(db, { locationId, numberId = null, descriptor })`:
  - change the contact match `.select('id')` to `.select('id, location_id')` and keep `contactId = contact?.id || null`; also keep `const contactHome = contact?.location_id`.
  - before `const { data: existingConv } = …`, add:

```js
  // WAHOMESTUDIO.1 (R1) — the thread for a contact whose home studio has no
  // number of its own sits at that studio (where the webhook files their
  // messages), stamped with the receiving number.
  const home = contactId ? await numberlessHomeStudio(db, { id: contactId, location_id: contactHome }, locationId) : null
  const threadLocationId = home || locationId
```

  - replace `locationId` with `threadLocationId` in the conversation lookup, insert (`location_id: threadLocationId`, plus `...(home && numberId ? { whatsapp_number_id: numberId } : {})`), the race re-read, and the `whatsapp_messages` insert's `location_id`. Leave every other use of `locationId` (the org scope of the contact match) as is.
  - import: `import { numberlessHomeStudio } from './whatsapp-thread-location'`.

- [ ] **Step 6: Callers table.** In the webhook row (`src/app/api/webhooks/whatsapp/route.js`) the counts stay `resolveWhatsAppNumberByPhoneNumberId: 2, getLocationWhatsAppNumberConfig: 1`; replace the WANUMBERLESS.1 sentence of `why` with: "WAHOMESTUDIO.1: a contact’s thread is filed at their own studio; getLocationWhatsAppNumberConfig decides only whether the receiving number is stamped on it (none there, or a failed lookup, logged → stamped; replies then go through it, R4); route.reply-number.test.js."

- [ ] **Step 7: Run**

Run: `npx vitest run src/app/api/webhooks/whatsapp src/lib/whatsapp-coexistence-ingest.test.js tests/whatsapp-config-callers.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/webhooks/whatsapp/route.js src/app/api/webhooks/whatsapp/route.reply-number.test.js src/lib/whatsapp-coexistence-ingest.js src/lib/whatsapp-coexistence-ingest.test.js tests/whatsapp-config-callers.test.js
git commit -m "WAHOMESTUDIO.1 — inbound and coexistence file at the contact's own studio, stamped with the receiving number"
```

---

### Task 6: Media, STOP/START ack and block go through the thread (R6)

**Files:**
- Modify: `src/lib/whatsapp-media-server.js` (`ensureMediaRehosted`, l.~43-60)
- Modify: `src/app/api/whatsapp/media/[messageId]/route.js` (select gains `conversation_id`)
- Modify: `src/lib/whatsapp-consent.js:~209`
- Modify: `src/app/api/whatsapp/conversations/[id]/block/route.js:~42`
- Test: `src/lib/whatsapp-media-server.test.js`, `src/lib/whatsapp-consent.test.js`, `src/app/api/whatsapp/conversations/[id]/no-number.test.js`
- Modify: `tests/whatsapp-config-callers.test.js` (media-server row)

**Interfaces:**
- Consumes: `getConversationNumberConfig` (Task 2); rehost objects carry `conversation_id` (Task 5).

- [ ] **Step 1: Failing tests.**

`src/lib/whatsapp-media-server.test.js` — add `getConversationNumberConfig: vi.fn(async () => null)` to the `./whatsapp-config` mock and import it; add:

```js
it('WAHOMESTUDIO.1 — a message in a thread replying through a sibling’s number is fetched with THAT number’s token', async () => {
  getConversationNumberConfig.mockResolvedValue({ source: 'db', token: 'tok-thread', phoneNumberId: 'PNI-THREAD', locationId: 'a0000000-0000-4000-8000-000000000009' })
  const db = makeDb()
  const path = await ensureMediaRehosted(db, { ...MSG, conversation_id: 'c0000000-0000-4000-8000-000000000001' })
  expect(path).toEqual(expect.any(String))
  expect(getConversationNumberConfig).toHaveBeenCalledWith(LOC, 'c0000000-0000-4000-8000-000000000001')
  expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-thread')
})
```

`src/lib/whatsapp-consent.test.js` — in the STOP test change the third `toHaveBeenCalledWith` argument to `expect.objectContaining({ locationId: 'loc1', replyInConversation: <the conversationId that test passes> })` (read the test's call to `applyWhatsappConsentKeyword` for the id).

`no-number.test.js` — add:

```js
it('WAHOMESTUDIO.1 — block resolves the number through the thread', async () => {
  createServerClient.mockReturnValue(makeDb())
  setWhatsAppUserBlockState.mockResolvedValue({})
  await block(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'block' }) }), { params: Promise.resolve({ id: 'conv-1' }) })
  expect(setWhatsAppUserBlockState).toHaveBeenCalledWith(CONV.wa_phone, true, { locationId: LOC, replyInConversation: 'conv-1' })
})
```

(Match the request/params shape the file's existing block test uses.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/whatsapp-media-server.test.js src/lib/whatsapp-consent.test.js 'src/app/api/whatsapp/conversations/[id]/no-number.test.js'`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Implement.**

`whatsapp-media-server.js`: import `getConversationNumberConfig` alongside `getLocationWhatsAppNumberConfig`; replace the config block:

```js
  // WACONFIGFALLBACK.1 — the message's location's OWN number, never another
  // studio's by accident. WAHOMESTUDIO.1 — or, for a message in a thread that
  // replies through a same-organisation sibling's number (a studio with none
  // of its own), the thread's number, which is the one Meta delivered it to.
  // None → null (the inbox's graceful gap).
  let config
  try {
    config = (message.conversation_id && await getConversationNumberConfig(message.location_id, message.conversation_id))
      || await getLocationWhatsAppNumberConfig(message.location_id)
  } catch {
    return null
  }
```

`media/[messageId]/route.js`: change the select to `'id, location_id, conversation_id, message_type, media_mime_type, media_url, media_external_id, media_storage_path'`.

`whatsapp-consent.js`: `await sendTextMessage(to, ack, { locationId, ...(conversationId ? { replyInConversation: conversationId } : {}) })` with comment `// WAHOMESTUDIO.1 — through the thread's number (a number-less studio's thread replies through its sibling's).`

`block/route.js`: `await setWhatsAppUserBlockState(conversation.wa_phone, blocked, { locationId: conversation.location_id, replyInConversation: conversation.id })` with comment `// WAHOMESTUDIO.1 — block on the number this thread talks through (Meta blocks per business number).`

- [ ] **Step 4: Callers table.** Media-server row: `calls: { getLocationWhatsAppNumberConfig: 1, getConversationNumberConfig: 1 }`, `why`: "inbound media fetched with the thread's number when it replies through a same-org sibling's (WAHOMESTUDIO.1), else the message location’s own token; none → null (the inbox’s graceful gap). whatsapp-media-server.test.js." Consent and block rows: counts unchanged; append to each `why`: " WAHOMESTUDIO.1: through the thread (replyInConversation)."

- [ ] **Step 5: Run**

Run: `npx vitest run src/lib/whatsapp-media-server.test.js src/lib/whatsapp-consent.test.js 'src/app/api/whatsapp/conversations/[id]' src/app/api/whatsapp/media tests/whatsapp-config-callers.test.js && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-media-server.js src/lib/whatsapp-media-server.test.js 'src/app/api/whatsapp/media/[messageId]/route.js' src/lib/whatsapp-consent.js src/lib/whatsapp-consent.test.js 'src/app/api/whatsapp/conversations/[id]/block/route.js' 'src/app/api/whatsapp/conversations/[id]/no-number.test.js' tests/whatsapp-config-callers.test.js
git commit -m "WAHOMESTUDIO.1 — media, consent ack and block resolve their number through the thread"
```

---

### Task 7: Templates from the number owner (R5)

**Files:**
- Modify: `src/app/api/whatsapp/conversations/[id]/send/route.js` (template branch ~l.96-150)
- Modify: `src/app/api/whatsapp/templates/route.js` (GET)
- Modify: `src/components/WAInbox.jsx` (`fetchTemplates` ~l.248)
- Test: `src/app/api/whatsapp/conversations/[id]/send/route.test.js` (exists? if not, create `route.template-studio.test.js` beside it), `src/app/api/whatsapp/templates/route.conversation.test.js` (create)
- Modify: `tests/whatsapp-config-callers.test.js` (rows for send route and templates route gain `templateLocationIdFor: 1`)

**Interfaces:**
- Consumes: `templateLocationIdFor(locationId, conversationId)` (Task 2).
- Produces: `GET /api/whatsapp/templates?conversation_id=<id>[&status=APPROVED]` → `{ success, templates, template_location_id }` authorised against the conversation's studio; no `sync` in this mode.

- [ ] **Step 1: Failing tests.**

Send route — build on the mocks of the existing send-route test in that folder (read it first), mock `@/lib/whatsapp-config` → `templateLocationIdFor: vi.fn()`, and define three helpers in the test file: `templateReq(body)` (a POST `Request` with `{ type: 'template', ...body }`), `params(id)` (`{ params: Promise.resolve({ id }) }`), and `templateRead()` (the recorded `whatsapp_templates` call from the fake db). Stub the conversation as `{ id: 'conv-1', location_id: 'loc-hatch', contacts: { id: 'k1', wa_phone: '15555550100', location_id: 'loc-hatch' } }`:

```js
it('WAHOMESTUDIO.1 — a template in a thread replying through a sibling’s number is read from that sibling’s templates', async () => {
  templateLocationIdFor.mockResolvedValue('loc-still')
  // conversation at loc-hatch; whatsapp_templates stub returns an APPROVED row only for location_id loc-still
  const res = await POST(templateReq({ template_name: 'welcome', template_language: 'en' }), params('conv-1'))
  expect(res.status).toBe(200)
  expect(templateRead().ops).toContainEqual(['eq', 'location_id', 'loc-still'])
})

it('WAHOMESTUDIO.1 — a FLOW-button template is refused from a thread whose template studio is another studio (Review Focus 3)', async () => {
  templateLocationIdFor.mockResolvedValue('loc-still')
  // template row components carry a FLOW button
  const res = await POST(templateReq({ template_name: 'book_flow', template_language: 'en' }), params('conv-1'))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('Booking Flow templates can’t be sent from this studio’s threads yet.')
  expect(sendTemplateMessage).not.toHaveBeenCalled()
})
```

Templates GET (`route.conversation.test.js`, mocks: `@/lib/auth` getCurrentUser + assertLocationAccess, `@/lib/supabase`, `@/lib/whatsapp-config` templateLocationIdFor, `@/lib/whatsapp-own-number`, `@/lib/whatsapp`):

```js
it('serves the number owner’s APPROVED templates for a conversation, authorised on the conversation’s studio', async () => {
  templateLocationIdFor.mockResolvedValue('loc-still')
  const res = await GET({ url: 'https://crm.test/api/whatsapp/templates?conversation_id=conv-1&status=APPROVED' })
  const body = await res.json()
  expect(assertLocationAccess).toHaveBeenCalledWith(expect.anything(), 'loc-hatch')
  expect(body).toMatchObject({ success: true, template_location_id: 'loc-still' })
  expect(templatesRead().ops).toContainEqual(['eq', 'location_id', 'loc-still'])
})
it('an unknown conversation is a 404; no sync in this mode', async () => {
  const res = await GET({ url: 'https://crm.test/api/whatsapp/templates?conversation_id=nope&sync=true' })
  expect(res.status).toBe(404)
  expect(ownNumberOrRefusal).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run 'src/app/api/whatsapp/conversations/[id]/send' src/app/api/whatsapp/templates`
Expected: FAIL.

- [ ] **Step 3: Implement the send route.** Import `templateLocationIdFor` from `@/lib/whatsapp-config`. At the top of the `if (messageType === 'template') {` branch, after the language line:

```js
    // WAHOMESTUDIO.1 (R5) — templates are synced per studio from the default
    // number's WABA; a thread replying through a same-organisation sibling's
    // number sends that sibling's templates.
    const templateLocationId = await templateLocationIdFor(conversation.location_id, conversation.id)
```

Use `templateLocationId` in the `whatsapp_templates` `.eq('location_id', …)` and in the `logError` payload (`templateLocationId`). Immediately before `if (flowButtonIndex(tplRow.components) >= 0) {` add:

```js
    // A Flow books at the studio its token names, and a Flow belongs to the
    // number owner's WABA: not sendable across studios in Phase 1 (spec §4).
    if (templateLocationId !== conversation.location_id && flowButtonIndex(tplRow.components) >= 0) {
      return NextResponse.json({ success: false, error: TEXT.flowOtherStudio }, { status: 400 })
    }
```

and add to the route's `TEXT` map: `flowOtherStudio: 'Booking Flow templates can’t be sent from this studio’s threads yet.',`.

- [ ] **Step 4: Implement templates GET.** At the start of GET after the user check:

```js
  const { searchParams } = new URL(request.url)
  // WAHOMESTUDIO.1 (R5) — the picker inside a thread asks by conversation: a
  // thread replying through a same-organisation sibling's number lists that
  // sibling's templates. Authorised on the CONVERSATION's studio (Hatch staff
  // need no Stillorgan access); cached rows only, never a sync.
  const conversationId = searchParams.get('conversation_id')
  if (conversationId) {
    const db = createServerClient()
    const { data: conv, error: convErr } = await db.from('whatsapp_conversations')
      .select('id, location_id').eq('id', conversationId).maybeSingle()
    if (convErr) return NextResponse.json({ success: false, error: 'Could not load the conversation' }, { status: 500 })
    if (!conv) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    const convGuard = assertLocationAccess(user, conv.location_id)
    if (convGuard) return convGuard
    const templateLocationId = await templateLocationIdFor(conv.location_id, conv.id)
    let q = db.from('whatsapp_templates').select('*').eq('location_id', templateLocationId)
    const status = searchParams.get('status')
    if (status) q = q.eq('status', status)
    const { data: templates, error } = await q.order('name')
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, templates: templates || [], template_location_id: templateLocationId })
  }
```

Then remove the now-duplicate `const { searchParams } = new URL(request.url)` below it. Match the existing cached-read select/order of the location mode (read the rest of GET; if it selects a narrower column list or orders differently, use the same here so both modes return identical row shapes).

- [ ] **Step 5: Implement the inbox picker.** In `WAInbox.jsx` change `fetchTemplates`:

```js
  // WAHOMESTUDIO.1 — inside a thread, ask by conversation: a thread replying
  // through a sibling studio's number lists that studio's templates.
  const fetchTemplates = useCallback(async () => {
    try {
      const q = conversation?.id
        ? `conversation_id=${conversation.id}&status=APPROVED`
        : `location_id=${locationId}&status=APPROVED`
      const res = await fetch(`/api/whatsapp/templates?${q}`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch (err) {
      console.error('Failed to fetch templates:', err)
    }
  }, [locationId, conversation?.id])
```

and add an effect after the initial-load effect: `useEffect(() => { if (conversation?.id) fetchTemplates() }, [conversation?.id, fetchTemplates])`. (`conversation` is the selected-thread state used elsewhere in this component; confirm the name.)

- [ ] **Step 6: Callers table.** Send route row: add `templateLocationIdFor: 1` to `calls`, append to `why`: " WAHOMESTUDIO.1: template rows read from templateLocationIdFor (the thread number's owner); a Flow-button template across studios is a 400." Templates route row: add `templateLocationIdFor: 1`, append " WAHOMESTUDIO.1: ?conversation_id= serves the thread number owner's cached rows, no sync."

- [ ] **Step 7: Run**

Run: `npx vitest run src/app/api/whatsapp tests/whatsapp-config-callers.test.js src/components && npm run check:location-scoping && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/api/whatsapp/conversations/[id]/send' src/app/api/whatsapp/templates src/components/WAInbox.jsx tests/whatsapp-config-callers.test.js
git commit -m "WAHOMESTUDIO.1 — a thread's templates come from the studio that owns its number"
```

---

### Task 8: "Move to studio" route + inbox menu (R7)

**Files:**
- Create: `src/app/api/whatsapp/conversations/[id]/move/route.js`
- Test: `src/app/api/whatsapp/conversations/[id]/move/route.test.js`
- Modify: `src/components/WAInbox.jsx` (overflow menu ~l.903)
- Modify: `src/lib/openapi.js` (after the block registration ~l.4205)

**Interfaces:**
- Consumes: `public.move_whatsapp_conversation` (Task 1).
- Produces: `GET /api/whatsapp/conversations/[id]/move` → `{ success, data: { targets: [{ id, name }] } }` (the caller's other studios in the thread's organisation, where they have WhatsApp inbox access); `POST … { location_id }` → `{ success, data: { conversation_id, merged } }`.

- [ ] **Step 1: Failing test**

```js
// WAHOMESTUDIO.1 (R7) — staff move a thread between studios of ONE
// organisation. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
  requireWhatsAppInboxAnywhere: vi.fn(() => null),
  requireWhatsAppInboxAt: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
import { GET, POST } from './route.js'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const CONV = { id: 'conv-1', location_id: 'loc-still' }
const LOCS = [
  { id: 'loc-still', name: 'Stillorgan', organization_id: 'O1' },
  { id: 'loc-hatch', name: 'Hatch Street', organization_id: 'O1' },
  { id: 'loc-other', name: 'Elsewhere', organization_id: 'O2' },
]
let rpc
function makeDb() {
  rpc = vi.fn(async () => ({ data: { conversation_id: 'conv-1', merged: false }, error: null }))
  return {
    rpc,
    from: (table) => {
      const filters = []
      const run = () => {
        const src = table === 'whatsapp_conversations' ? [CONV] : table === 'locations' ? LOCS : []
        return { data: src.filter((r) => filters.every((f) => f(r))), error: null }
      }
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return b },
        order: () => b,
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}
const params = { params: Promise.resolve({ id: 'conv-1' }) }
const post = (body) => new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', locationIds: ['loc-still', 'loc-hatch', 'loc-other'] })
  createServerClient.mockReturnValue(makeDb())
})

describe('GET move targets', () => {
  it('lists the caller’s other studios in the thread’s organisation only', async () => {
    const body = await (await GET(new Request('http://x'), params)).json()
    expect(body.data.targets).toEqual([{ id: 'loc-hatch', name: 'Hatch Street' }])
  })
})

describe('POST move', () => {
  it('moves through the SQL function', async () => {
    const res = await POST(post({ location_id: 'loc-hatch' }), params)
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('move_whatsapp_conversation', { p_conversation_id: 'conv-1', p_target_location_id: 'loc-hatch' })
  })
  it('another organisation or the same studio → 400, the function never runs (Review Focus 5)', async () => {
    expect((await POST(post({ location_id: 'loc-other' }), params)).status).toBe(400)
    expect((await POST(post({ location_id: 'loc-still' }), params)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('no access at the target → its 404, the function never runs', async () => {
    assertLocationAccessOr404.mockImplementation((u, loc) => (loc === 'loc-hatch' ? new Response(null, { status: 404 }) : null))
    expect((await POST(post({ location_id: 'loc-hatch' }), params)).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a function error is a 500 with no detail leaked', async () => {
    const db = makeDb()
    db.rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ location_id: 'loc-hatch' }), params)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not move the conversation.')
  })
})
```

Before writing the route, read `src/lib/auth.js` for the user field that lists the caller's studios (`locationIds`, `rolesByLocation`, or `locations`) and use THAT in both the route and this test's `getCurrentUser` mock.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run 'src/app/api/whatsapp/conversations/[id]/move'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'

// WAHOMESTUDIO.1 (R7) — move a WhatsApp thread to another studio of the SAME
// organisation (an unknown sender who turns out to be a Hatch customer, a
// thread filed before WAHOMESTUDIO.1). The move (or merge into an existing
// thread there) is ONE SQL function, move_whatsapp_conversation (mig 723).
// The caller needs WhatsApp inbox access at BOTH studios. Registered in
// src/lib/openapi.js.
const MoveSchema = z.object({ location_id: uuidLike })

async function load(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { res: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return { res: perm }
  const db = createServerClient()
  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, location_id').eq('id', params.id).maybeSingle()
  if (!conversation) return { res: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  const guard = assertLocationAccessOr404(user, conversation.location_id) || requireWhatsAppInboxAt(user, conversation.location_id)
  if (guard) return { res: guard }
  const { data: source } = await db.from('locations').select('id, organization_id').eq('id', conversation.location_id).maybeSingle()
  return { user, db, conversation, orgId: source?.organization_id || null }
}

export async function GET(request, props) {
  const ctx = await load(props)
  if (ctx.res) return ctx.res
  const { user, db, conversation, orgId } = ctx
  const ids = (user.locationIds || []).filter((id) => id !== conversation.location_id)
  if (!orgId || ids.length === 0) return NextResponse.json({ success: true, data: { targets: [] } })
  const { data: locs } = await db.from('locations').select('id, name, organization_id').in('id', ids).eq('organization_id', orgId).order('name')
  const targets = (locs || [])
    .filter((l) => !requireWhatsAppInboxAt(user, l.id))
    .map((l) => ({ id: l.id, name: l.name }))
  return NextResponse.json({ success: true, data: { targets } })
}

export async function POST(request, props) {
  const ctx = await load(props)
  if (ctx.res) return ctx.res
  const { user, db, conversation, orgId } = ctx
  const v = await validateBody(request, MoveSchema)
  if (!v.ok) return v.response
  const target = v.data.location_id
  if (target === conversation.location_id) {
    return NextResponse.json({ success: false, error: 'The conversation is already at this studio.' }, { status: 400 })
  }
  const { data: dest } = await db.from('locations').select('id, organization_id').eq('id', target).maybeSingle()
  if (!dest || !orgId || dest.organization_id !== orgId) {
    return NextResponse.json({ success: false, error: 'A conversation can only move to a studio in the same organisation.' }, { status: 400 })
  }
  const guard = assertLocationAccessOr404(user, target) || requireWhatsAppInboxAt(user, target)
  if (guard) return guard

  const { data, error } = await db.rpc('move_whatsapp_conversation', { p_conversation_id: conversation.id, p_target_location_id: target })
  if (error) {
    logError('wa-move', 'move_whatsapp_conversation failed', { conversationId: conversation.id, target, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not move the conversation.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { conversation_id: data?.conversation_id || conversation.id, merged: !!data?.merged } })
}
```

- [ ] **Step 4: Register in openapi.js** after the block registration:

```js
// WAHOMESTUDIO.1 — move a WhatsApp thread to another studio of the same organisation
registry.registerPath({
  method: 'get',
  path: '/api/whatsapp/conversations/{id}/move',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'List the studios a WhatsApp conversation can move to',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'The caller’s other studios in the conversation’s organisation' },
    404: { description: 'Conversation not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversations/{id}/move',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Move (or merge) a WhatsApp conversation into another studio of the same organisation',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ location_id: uuidLike }).openapi('WaMoveConversation') } } },
  },
  responses: {
    200: { description: 'Moved; merged=true when it joined an existing thread there' },
    400: { description: 'Same studio, or a studio in another organisation', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Conversation or target studio not found for the caller', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The move failed; nothing changed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 5: Inbox menu.** In `WAInbox.jsx`:
  - state: `const [moveTargets, setMoveTargets] = useState(null)` (null = not loaded).
  - when the overflow menu opens (`setShowMoreMenu(v => !v)` handler), if opening and `conversation?.id`, fetch targets:

```js
  async function loadMoveTargets(conv) {
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conv.id}/move`)
      const j = await res.json().catch(() => ({}))
      setMoveTargets(j.success ? j.data.targets : [])
    } catch { setMoveTargets([]) }
  }

  async function moveTo(conv, target) {
    if (!window.confirm(`Move this conversation to ${target.name}? It will leave this inbox.`)) return
    const res = await fetch(`/api/whatsapp/conversations/${conv.id}/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: target.id }),
    })
    const j = await res.json().catch(() => ({}))
    if (!j.success) { window.alert(j.error || 'Move failed'); return }
    setConversations(prev => prev.filter(c => c.id !== conv.id))
    setConversation(null)
  }
```

  - in the menu, after the Block button:

```jsx
                        {(moveTargets || []).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            onClick={() => { setShowMoreMenu(false); moveTo(conversation, t) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-un1t-text hover:bg-un1t-border/40 transition-colors"
                          >
                            Move to {t.name}
                          </button>
                        ))}
```

  Reset `setMoveTargets(null)` when the selected conversation changes. Use the existing setter names for the conversation list / selection (`setConversations`, `setConversation` as in `toggleBlocked`).

- [ ] **Step 6: Run**

Run: `npx vitest run 'src/app/api/whatsapp/conversations/[id]/move' src/components && npm run check:route-guards && npm run check:location-scoping && npm run check:rpc-names && npm run check:guardrails`
Expected: PASS. If `check:location-scoping` flags the `locations`/`whatsapp_conversations` reads, the scoping is `assertLocationAccessOr404` on the row's `location_id` after the read (same as the block route) — mirror how the block route is accepted, do not add to `EXEMPT`.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/whatsapp/conversations/[id]/move' src/components/WAInbox.jsx src/lib/openapi.js
git commit -m "WAHOMESTUDIO.1 — Move to studio: staff re-file a WhatsApp thread within the organisation"
```

---

### Task 9: Invariant, CI mirror, build, PR

**Files:**
- Modify: `CLAUDE.md` (WACONFIGFALLBACK.1 bullet)
- Create after PR: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: CLAUDE.md.** Append to the WACONFIGFALLBACK.1 bullet, after "Never throw it through a runner that would kill other work.":

```
**One exception (WAHOMESTUDIO.1, mig 723):** a reply INTO a thread filed at a number-less studio goes from the number stamped on the thread when that number belongs to a studio of the SAME organisation (`getConversationNumberConfig`). The thread is filed at the customer's own studio (`numberlessHomeStudio`, the webhook's R2), so the original harm — a reply landing in another studio's inbox and Mia — cannot recur. Every send that does not start from a thread still refuses.
```

- [ ] **Step 2: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`
Expected: all PASS. (8GB machine: run `npm test` alone first if memory-starved.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "WAHOMESTUDIO.1 — WhatsApp threads filed at the customer's real studio" --body "<summary of R1–R7, migs 723/724, rollout order (723 before merge, 724 right after deploy), rollback = move back with move_whatsapp_conversation, link to spec>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 5: Changelog entry** `docs/changelog/entries/<PR>.md` per `docs/changelog/entries/README.md`: `| #<PR> | WAHOMESTUDIO.1 — WhatsApp threads filed at the customer's real studio | 2026-10-15. Hatch threads sit in the Hatch inbox and reply through the Stillorgan number (same-org sibling stamp, R4); outbound + coexistence file at a numberless home studio; templates from the number owner; Move to studio (mig 723); backfill mig 724. |`. Run `npx vitest run tests/changelog-entries.test.js`, commit, push.

---

### Task 10: Rollout (needs Richard's go-ahead before step 1 and step 3)

- [ ] **Step 1: Apply 723** via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj` (name `723_move_whatsapp_conversation`); then `get_advisors` (security).
- [ ] **Step 2: Dry-run count** (MCP `execute_sql`, read-only): the 724 loop's SELECT as a `count(*)`, plus how many have a thread already at home (merge count). Expected ≈120, 0 merges.
- [ ] **Step 3: Merge the PR** once CI is green; wait for the Vercel production deploy to be READY.
- [ ] **Step 4: Apply 724** immediately; read the NOTICE (moved/merged).
- [ ] **Step 5: Verify**: the dry-run SELECT returns 0; one Hatch thread's messages show `location_id` = Hatch; a Hatch staff reply in that thread sends (check `whatsapp_messages` outbound row with a `wa_message_id`) — Richard sends or approves sending a real reply.
- [ ] **Step 6: Memory**: update the WA numberless-studio memory file and MEMORY.md hook (WANUMBERLESS.1 superseded by WAHOMESTUDIO.1; Mia at Stillorgan no longer reaches Hatch customers).
