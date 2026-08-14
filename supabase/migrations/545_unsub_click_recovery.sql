-- 545 — honour the opt-outs dropped before mig 522 / PR #1353.
--
-- WHO THESE ARE
-- ─────────────
-- 160 contacts who CLICKED an unsubscribe link in a marketing email and were
-- still mailable on 2026-08-14. 96 clicked more than once, 8 clicked four or
-- more times, 56 have clicks spanning over 30 days. Reviewed and approved by
-- Richard from unsub-recovery-2026-08-14.csv (152 human / 9 review / 0 scanner).
--
-- NOT ONE of them clicked in 90%+ of the campaigns they received, which is the
-- signature a link scanner leaves, so none were excluded as machine traffic.
--
-- WHY campaign_link_clicks IS THE ONLY EVIDENCE
-- ────────────────────────────────────────────
-- Two mechanisms dropped these on the floor:
--   1. Until 2026-08-11 both consent routes carried flat per-IP limiters spent
--      BEFORE the token was read. Gmail POSTs one-click unsubscribes from a
--      shared proxy pool, so the overflow got a 429 and NOTHING was written.
--   2. The footer link only opened a confirm page, so anyone who clicked and
--      closed the tab left no record either (fixed by UNSUBAUTO.1, #1391).
--
-- Neither leaves a consent_log row, by construction. Cross-checked against
-- Postmark's own suppression list on 2026-08-14: ZERO of these contacts appear
-- in it — Postmark never saw an unsubscribe because there was never one to see.
--
-- SCOPE: STILLORGAN, EMAIL ONLY — deliberately not global
-- ──────────────────────────────────────────────────────
-- One of these contacts is also on the Hatch Street list via a waitlist_form
-- opt-in she made on 2026-06-08 (the LEADCAP.1 shape). Writing contact_preferences
-- instead would fan out through the mig 489 trigger and strip her from a list she
-- explicitly joined. Leaving one studio's list must never remove somebody from
-- another. SMS and WhatsApp are untouched: they clicked a link in an EMAIL.
--
-- Consequence, accepted: a location-scoped opt-out does not push a Postmark
-- suppression (PMSUPP.1 — suppressions are per stream, not per location), so
-- for these 160 our own database remains the only gate.
--
-- DIRECTION OF ERROR
-- ──────────────────
-- A false positive costs one marketing email to somebody who did not ask to
-- leave, and they can rejoin from any later mail. A false negative is
-- continuing to mail somebody who asked up to six times. Not symmetric.
--
-- APPLIED to prod 2026-08-14. 160 rows updated, 160 consent_log rows written.
-- Verified after: clickers still mailable anywhere = 1 (the Hatch waitlist row).

with recovered as (
  select unnest(array['00317e2e-6cfd-422a-8565-fa52fbd42da1','0555f2a3-adca-4846-9f51-f1f4acbf2d06','069bed02-62c0-4aac-b59e-e007b2a5636b','07ecf4a3-3f48-4aa9-8113-5c0c6705a733','088c4d05-e75c-404b-95b0-c655da5b55c7','0ba6593b-8943-429d-b5c8-d5a30ea0e776','0cf572f5-f1c3-45f6-abfe-c523680a6d21','0cfe6c54-8f69-4609-abc5-02f533c9b441','0e6964a8-c69c-432b-958a-1014ce45465d','12ccbd68-23a5-4e49-8907-cdae9639f787','14416535-9a13-459e-8cf2-bf2df8539375','15d9ba53-60b4-4628-ad60-2468fd845d0e','15e5779c-1cbe-4568-aa64-8640aad7bd72','17acf0d2-15b4-4258-82c1-f6652bd8f80e','19236bff-5f70-432c-a283-a2ded6cf862f','19be15e6-1e58-4d59-b3a1-18d5eeb7ba98','1a4040a9-d460-4629-9630-befe8822f3b7','1a41385e-52e4-406c-b227-0372ad76bbdb','1a677b52-29e0-4f8e-8f88-2577c75f03f8','1a694745-8a98-4c78-b6cd-1fad5a416362','1e361976-1db1-4358-a595-59b3050febb1','23ee45ef-7dec-41ac-8712-c5afcc87ce68','24e3525b-4237-499b-9823-dd3015df0f6b','26d96cb3-cd7b-46ac-ac4c-09bf174159f7','2787a14b-dd01-4398-a7bd-48edb19618ed','278d0224-56c3-49f6-9d78-e1367264836c','282084a8-fd98-43a7-a894-edf6f4051af1','339d387c-5205-4d82-81ee-2530e73f1cc8','33cb7dbf-3237-4c11-b908-5a07424e5a36','34e5de18-b24a-43eb-896f-2d191b632996','35b89ba5-b6bb-4cb6-9f0d-b8e173ba93f5','364fcbf8-837c-41e7-a4ca-d87ade313ae6','37cb68c3-22e7-412e-bf85-02e0937066b8','39c80cbe-5de2-4f02-aaae-8c14537943e8','3a6981d7-8bc2-4498-a57f-ee4b4dc7a2da','3bc182f1-c9be-4ee7-acdf-3a357c91da1b','3e5c5646-88b1-4cff-9b65-40d6e427d2c2','3fadf798-db52-4cb5-aa05-6efed86cde2c','42538a14-a683-4643-9938-83a021f2a039','429ec194-8af6-45a2-85ca-d8d5b1cebbf5','450ee41b-1d33-418d-a76d-e975b4e8b988','46fbcc54-7fc1-4351-a479-b5d13a86d177','4848160b-28a5-418b-a461-8b1fde7dffd2','49015f6d-c2fd-44d5-9f24-fbf34886a3d8','4df810e4-cc4c-4e22-b623-bc2f478e148c','4e6c1908-2ba6-44a9-9ccd-f6d51ec6db8e','4fa90f39-bce5-4c7f-91e7-6dd1ef789846','4fa9a4f7-e7ac-42aa-913b-8e81454de9a4','5307828a-89bb-4438-854d-ff903ec46f93','54dce0e0-30fa-4950-b78f-162c9f3651b1','54ee7e6c-e73b-48b2-8939-5fea661a9a93','55a38aba-bf04-4c96-b706-c4674800a5fd','5939ea9c-6c44-4756-ba08-cabb7be07e1b','59e4ad6d-9ef6-43cb-8b73-eceb262d89f8','5a72096b-2ba6-41c2-a0eb-36155a1c9eb9','5c17b91e-b200-4f3a-bfe8-08610555b996','5c27b067-3763-4135-a963-0df7b790802e','5ddd0f72-004b-4d43-9deb-0f93f3b8286b','5f1f14d7-7523-4206-9362-b927ede7367a','61eadef0-4c96-4134-85ce-f1a6e2a10b64','620d437e-bc9f-4338-bff9-cd342174c11d','633b2ce2-f4f3-4fd3-b795-928a77bb32a7','63a6c9a7-8f87-41b3-8ed4-a8199863ec81','649bf882-4932-47cd-ac51-f9eafd9d6904','655506f4-39d4-4d70-88b0-3eac481f0151','65d1ead7-e99a-4dc8-b768-bde044dd6879','66055670-e0b6-49e2-b918-2f31596e27d1','67309635-81c1-48ee-8bee-9590bc8d48d4','67f2f31f-d6af-4007-80c2-14ada09543f6','68fe0d5a-9a36-404b-b282-acd78ba20de5','6a7140de-1479-437d-abdd-c3ac9209d629','6a963256-86ed-40b1-a58d-6cb5453bceef','6af19412-c9b8-409a-9cc6-7f0581147e4e','6e51e764-bbd7-4bce-ac32-8203e4d0996f','6e952ace-b8bb-48a7-bdc0-cbce8a60da83','6ffc7682-6100-41a9-9308-95b6f1c64f04','71cb87c8-ee2f-4de0-a303-7a8654df0bf5','7406e3f9-04dd-4ad0-8df1-2191317a18eb','79b71c83-ea50-422e-a6c1-971cc535697b','7c570914-49e4-4c8f-8881-11f0740e8212','7c9d1113-d97d-46d5-b33a-edc9c32c1ad7','7f591e46-be44-4af0-b8ca-d394b040a7e5','7fa3c4ea-f1b0-4269-b3a9-b9c260b850f3','8cdcd864-4725-447a-89db-37cae4ca337d','8f374317-3ebb-4ad5-a00d-79c260864a7d','8fa1335d-4ef8-4726-baf0-beb9bebc68aa','90421469-08bc-4ac8-a6f6-4a420c83cfea','9371d325-7aed-4bc2-ae0a-3451b95b89b9','98c05fa9-a2b6-467b-81c9-d53f92f20697','9b0a2b55-1db8-41c4-ae0a-2d184b213c41','9b5f453d-a221-4989-983f-c849b761d07a','9bce8a64-7de5-4b2d-b233-385ee9d744ab','a0381cb0-eb18-432a-9388-72cb9ced4212','a056c7c5-8bbf-4c29-81cc-10911bf02538','a0e000b4-15ec-46eb-bcbe-47962a119928','a2859226-4952-4961-9fa2-ff11161aea68','a316d1d8-3bfb-42fc-9664-50bbb9eb352a','a45e1980-c6da-4a3e-8385-4d5c266982f3','a5ca984e-ce76-4b13-aec0-2d6ed2874f1b','a63046a4-a3cb-49a3-a9c5-34fa814aef0e','a66dff18-93b3-448f-8774-9c987c39c94f','a9ef2687-c190-4b84-963c-62cd1d0653b9','aac70f08-614e-4c25-8f07-dc3d352a7a22','ab08cafd-0f7f-48f4-9832-e06140016bce','ab544212-8927-4d4e-a7ed-f3163f28e6cc','abf55f2b-4805-4a7b-a7aa-1193af506c8b','b20ba2b0-ceda-41f3-b378-ad0a2184048e','b3a62e4e-882a-4328-8791-e0e93ddb4331','b3be2bd3-f3e5-4c97-b8b9-6fab608e666d','b3e57b3a-b88d-4132-8e6b-b4f4a6cde334','b4ad2b3c-d235-4829-953d-9a3a2f23a831','b7c98274-fa82-449b-8052-cec1d2efbf43','bac312c4-7d17-4374-86f1-ed01081f37a1','bb069027-3cd2-4ac3-b237-0db015548089','bb3d82d6-c036-4f57-906f-7615e47e10e5','bd0a699c-126c-4462-b6ce-8ff0d87d39d7','c29d69f5-8e2e-4e77-8da2-ec5c8d2aabfd','c2abef23-2eeb-447a-b3e2-8d3c386e6766','c379a601-d90a-451a-ad40-d218d365d11e','c6207f4c-8b67-466a-98de-dcc7f731436f','c7b0e94c-e9eb-45e9-adc2-7dda5eb1e101','cbf2c537-b66b-40d7-b414-a11c428345cd','ccf64dbe-7ade-42ae-af47-d35976170cb9','cd681d76-c41a-4c7e-bdc4-eca06feeed81','cdd4db68-1fa0-431a-b35d-82fdc7a1d842','cf9d7cdd-9e8a-4f86-b57c-e9c05a263e5f','d13832b8-905b-4d0a-9aad-3fab597afdd7','d6091249-8153-4cae-b846-159c50dd32c7','d81d0185-4dcb-40c4-bee2-00a80fc25f3c','d840c1cf-762c-4481-8481-20487620fd8e','d8be4ce9-c857-4cdb-b196-3978d9284a02','dcba6c5e-2d87-44a2-ba09-2639e30a956f','df81c2bb-0736-4741-811f-615aa7475082','e0c4614d-050d-4bad-b4eb-d717be7fd653','e12debf7-d5c2-4950-bdad-c3de3e3087de','e1d2307b-b6f9-47ae-9e2b-38267caf1234','e2c1635b-751e-49d6-8725-066a3e035eb3','e30e2adb-e240-4f50-916a-de90553a34c9','e384afdd-9f25-4eaf-b776-552348dc369e','e567c8fe-9814-4fb4-9a09-32ccee04bd5c','e6443709-0d3a-4d60-a470-e51c65cf221b','eb34a403-9a35-4922-b780-559593ff9c9d','ec3aa3da-bb40-4291-b71b-1819e92784e0','ec6978d4-559d-4115-8423-a0e17afb4d2c','eeb5c393-4479-4aba-8a5e-9046887aee51','f0447618-afca-4afc-b94d-6afa1110b68a','f2254460-17c4-4880-9c25-459daa12d3d7','f41e2867-5731-4591-9016-2ea8814efcf1','f4650e72-8eec-4e09-a30b-073b1b94b217','f529ef96-8901-461c-82b8-c03940ffda24','f6ddcc72-e651-45f6-8d1d-21041853c524','f768bb89-b3a9-4e6e-b989-45ba71679f83','f9b0cddb-4863-41d0-abe6-2c401274075e','f9f294d2-e70b-4102-996c-57ee11a1b48e','fb658d0d-e336-4d92-abc2-761cb00e7605','fcfccca3-5bda-4ef0-a3a9-347d4e9e56fa','fded455d-b048-48a6-9bcf-cc379efe1822','fe953889-743b-4a30-9b07-dad3953f69db','feb9ef60-0a08-4a3a-8fa3-6b62359cadb4','ff36f1ef-0bd9-450c-81ee-11ec96d7c2bf']::uuid[]) as contact_id
),
upd as (
  update contact_location_preferences clp
     set email_marketing = false,
         unsubscribed_at = coalesce(clp.unsubscribed_at, now()),
         updated_at      = now()
    from recovered r
   where clp.contact_id  = r.contact_id
     and clp.location_id  = 'a0000000-0000-0000-0000-000000000001'
     and clp.email_marketing = true
  returning clp.contact_id
)
insert into consent_log (contact_id, channel, action, source, location_id)
select contact_id, 'email_marketing', 'opt_out', 'unsub_click_recovery',
       'a0000000-0000-0000-0000-000000000001'::uuid
from upd;
