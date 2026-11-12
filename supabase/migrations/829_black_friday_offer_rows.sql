-- BLACKFRIDAY.8 — the Black Friday catalogue rows for both studios.
--
-- APPLY AFTER THE CODE DEPLOYS. The pages that render these rows (per-studio
-- storefront, fine print, un1t.online checkout) ship with this PR; applied
-- early, the production pages would show these rows under the old August copy.
--
-- New rows are INSERTED, never written over the existing Stillorgan ones:
-- past offer_purchases reference those by offer_id, and rewriting their name,
-- price or bonus would corrupt sale history. So every timed slug carries a
-- '-bf-2026' suffix; the two gift slugs are new and stay as written. The
-- ON CONFLICT (location_id, slug) DO UPDATE makes re-applying this file safe,
-- and it can only ever touch these new rows. The old August/November
-- membership and class_pack rows are switched off (not deleted).
--
-- Windows: memberships and packs 23 Nov 00:00 UTC to 30 Nov 23:59:59 UTC;
-- gift rows open Cyber Monday (30 Nov). Hatch's 1 Month row is inactive with
-- no un1t.online product until the product exists. Prices are in cents.

UPDATE public.sale_offers
   SET active = false, updated_at = now()
 WHERE location_id = 'a0000000-0000-0000-0000-000000000001'
   AND category IN ('membership', 'class_pack')
   AND slug NOT LIKE '%-bf-2026';

INSERT INTO public.sale_offers
  (location_id, slug, category, name, bonus_headline, description, price_cents,
   un1t_product_id, fine_print, active, starts_at, ends_at, sort)
VALUES
  ('a0000000-0000-0000-0000-000000000001', '1-year-membership-bf-2026', 'membership', '12 Month Membership', '+3 MONTHS FREE', '12 months of unlimited coached training, plus 3 months on the house.', 216900, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 1),
  ('a0000000-0000-0000-0000-000000000001', '6-month-membership-bf-2026', 'membership', '6 Month Membership', '+6 WEEKS FREE', '6 months of unlimited coached training, plus 6 weeks on the house.', 114400, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 2),
  ('a0000000-0000-0000-0000-000000000001', '3-month-membership-bf-2026', 'membership', '3 Month Membership', '+3 WEEKS FREE', '3 months of unlimited coached training, plus 3 weeks on the house.', 59700, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 3),
  ('a0000000-0000-0000-0000-000000000001', '1-month-membership-bf-2026', 'membership', '1 Month Membership', '+2 WEEKS FREE', '1 month of unlimited coached training, plus 2 weeks on the house.', 9900, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 4),
  ('a0000000-0000-0000-0000-000000000001', '30-class-pack-bf-2026', 'class_pack', '30 Class Pack', '+10 CLASSES FREE', '30 classes, plus 10 more on the house.', 51000, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 5),
  ('a0000000-0000-0000-0000-000000000001', '20-class-pack-bf-2026', 'class_pack', '20 Class Pack', '+5 CLASSES FREE', '20 classes, plus 5 more on the house.', 38000, NULL, '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 6),
  ('a0000000-0000-0000-0000-000000000001', 'cyber-monday-gift-card', 'gift_card', '€100 Gift Card + €20 Bonus', '+€20 BONUS CARD', 'Buy a €100 gift card and get a €20 bonus card free.', 10000, NULL, 'Your €100 gift card is valid for 5 years. The free €20 bonus card can be used from 1 January to 28 February 2027.', true, '2026-11-30 00:00:00+00', '2026-11-30 23:59:59+00', 7),
  ('a0000000-0000-0000-0000-000000000001', 'gift-a-reset', 'gift_card', 'Gift a Reset', 'GIFT A RESET', 'Give someone their first step into UN1T: a Reset, on us to give.', 3900, NULL, 'One Reset at UN1T Stillorgan, to be used within 12 months. If they''ve had a trial with us before, we''ll give them €39 of credit instead.', true, '2026-11-30 00:00:00+00', '2026-11-30 23:59:59+00', 8),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '1-year-membership-bf-2026', 'membership', '12 Month Membership', '+3 MONTHS FREE', '12 months of unlimited coached training, plus 3 months on the house.', 226800, 'a85d6e20-43a8-428a-8af4-5e305ac60aaf', 'Renews at €2,268 every 12 months after your bonus time. Cancel any time before.', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 1),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '6-month-membership-bf-2026', 'membership', '6 Month Membership', '+6 WEEKS FREE', '6 months of unlimited coached training, plus 6 weeks on the house.', 119400, 'd60b05bb-6a51-40f3-8643-32321c45fdcb', 'Renews at €1,194 every 6 months after your bonus time. Cancel any time before.', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 2),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '3-month-membership-bf-2026', 'membership', '3 Month Membership', '+3 WEEKS FREE', '3 months of unlimited coached training, plus 3 weeks on the house.', 62700, 'de6fbadc-fea7-4854-855e-8649f3abc305', 'Renews at €627 every 3 months after your bonus time. Cancel any time before.', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 3),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '1-month-membership-bf-2026', 'membership', '1 Month Membership', '+2 WEEKS FREE', '1 month of unlimited coached training, plus 2 weeks on the house.', 9900, NULL, '', false, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 4),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '30-class-pack-bf-2026', 'class_pack', '30 Class Pack', '+10 CLASSES FREE', '30 classes, plus 10 more on the house.', 54000, 'b1d7ab46-ba9e-4d28-918f-2f81009bb9d8', '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 5),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', '20-class-pack-bf-2026', 'class_pack', '20 Class Pack', '+5 CLASSES FREE', '20 classes, plus 5 more on the house.', 40000, '741855ef-9a50-4337-af2e-dbe087665af8', '', true, '2026-11-23 00:00:00+00', '2026-11-30 23:59:59+00', 6),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', 'cyber-monday-gift-card', 'gift_card', '€100 Gift Card + €20 Bonus', '+€20 BONUS CARD', 'Buy a €100 gift card and get a €20 bonus card free.', 10000, NULL, 'Your €100 gift card is valid for 5 years. The free €20 bonus card can be used from 1 January to 28 February 2027.', true, '2026-11-30 00:00:00+00', '2026-11-30 23:59:59+00', 7),
  ('28c78d6b-f7b3-4edf-8c7c-840bd047b3f4', 'gift-a-reset', 'gift_card', 'Gift a Reset', 'GIFT A RESET', 'Give someone their first step into UN1T: a Reset, on us to give.', 3900, NULL, 'One Reset at UN1T Hatch Street, to be used within 12 months. If they''ve had a trial with us before, we''ll give them €39 of credit instead.', true, '2026-11-30 00:00:00+00', '2026-11-30 23:59:59+00', 8)
ON CONFLICT (location_id, slug) DO UPDATE SET
  category       = EXCLUDED.category,
  name           = EXCLUDED.name,
  bonus_headline = EXCLUDED.bonus_headline,
  description    = EXCLUDED.description,
  price_cents    = EXCLUDED.price_cents,
  un1t_product_id = EXCLUDED.un1t_product_id,
  fine_print     = EXCLUDED.fine_print,
  active         = EXCLUDED.active,
  starts_at      = EXCLUDED.starts_at,
  ends_at        = EXCLUDED.ends_at,
  sort           = EXCLUDED.sort,
  updated_at     = now();

-- Stillorgan's legal line on the offer pages. Merged, so no other settings
-- key and no other offers_page key is touched.
UPDATE public.locations
   SET settings = jsonb_set(
         coalesce(settings, '{}'::jsonb),
         '{offers_page}',
         coalesce(settings->'offers_page', '{}'::jsonb)
           || '{"legalLine":"CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND"}'::jsonb)
 WHERE slug = 'un1t-stillorgan';
