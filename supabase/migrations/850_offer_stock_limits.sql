-- OFFERSTOCK.1 (mig 850): a real stock limit on a sale offer.
--
--   sale_offers.stock_limit   how many may be sold; NULL = no limit (every row
--                             today, so nothing changes until staff set one).
--
-- What uses up stock:
--   sold  every paid offer_purchases row, wherever it was bought (the page,
--         or the un1t.online app or desk: those arrive as origin 'off_page').
--   held  a checkout opened on the page in the last 35 minutes and not yet
--         settled, one per buyer email. Revolut orders expire after 30, so a
--         hold outlives the order it protects. A hold also covers the time a
--         un1t.online payment takes to reach the mirror (15-minute sync, then
--         the 2-minute sweep).
--
-- The limit is enforced HERE, by a BEFORE INSERT trigger holding a row lock on
-- the offer, so two buyers of the last one cannot both pass a check made in
-- application code. It applies only to a new page checkout (origin 'page',
-- state 'created'). A row recording money already taken is never refused: a
-- payment that arrived is honoured even if it takes the count over the limit.
-- A buyer's own earlier hold never blocks their retry.
--
-- SQLSTATE OFS01 = sold out, OFS02 = what is left is held by other checkouts
-- (src/lib/offer-stock.js reads both).

ALTER TABLE public.sale_offers
  ADD COLUMN IF NOT EXISTS stock_limit integer;

ALTER TABLE public.sale_offers
  DROP CONSTRAINT IF EXISTS sale_offers_stock_limit_check;
ALTER TABLE public.sale_offers
  ADD CONSTRAINT sale_offers_stock_limit_check
  CHECK (stock_limit IS NULL OR stock_limit > 0);

COMMENT ON COLUMN public.sale_offers.stock_limit IS
  'OFFERSTOCK.1 (mig 850): how many of this offer may be sold; NULL = no limit. Enforced by enforce_offer_stock on offer_purchases.';

CREATE OR REPLACE FUNCTION public.offer_stock_counts(p_offer_ids uuid[], p_exclude_email text DEFAULT NULL)
RETURNS TABLE (offer_id uuid, sold integer, held integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    o.id,
    (SELECT count(*)::integer
       FROM public.offer_purchases p
      WHERE p.offer_id = o.id AND p.state = 'paid'),
    (SELECT count(DISTINCT lower(p.buyer_email))::integer
       FROM public.offer_purchases p
      WHERE p.offer_id = o.id
        AND p.state = 'created'
        AND p.origin = 'page'
        AND p.created_at > now() - interval '35 minutes'
        AND (p_exclude_email IS NULL OR lower(p.buyer_email) <> lower(p_exclude_email)))
  FROM public.sale_offers o
  WHERE o.id = ANY (p_offer_ids)
$$;

REVOKE EXECUTE ON FUNCTION public.offer_stock_counts(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offer_stock_counts(uuid[], text) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_offer_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_limit integer;
  v_sold integer;
  v_held integer;
BEGIN
  IF NEW.origin <> 'page' OR NEW.state <> 'created' THEN
    RETURN NEW;
  END IF;

  -- No limit: no lock, so an unlimited offer's checkouts never queue.
  SELECT o.stock_limit INTO v_limit FROM public.sale_offers o WHERE o.id = NEW.offer_id;
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  -- NO KEY UPDATE: serialises checkouts of this offer without blocking the
  -- foreign-key checks of inserts that do not come through here. Re-read under
  -- the lock, in case staff changed the limit while this waited.
  SELECT o.stock_limit INTO v_limit FROM public.sale_offers o WHERE o.id = NEW.offer_id FOR NO KEY UPDATE;
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.sold, c.held INTO v_sold, v_held
    FROM public.offer_stock_counts(ARRAY[NEW.offer_id], NEW.buyer_email) c;

  IF v_sold >= v_limit THEN
    RAISE EXCEPTION 'offer sold out' USING ERRCODE = 'OFS01';
  END IF;
  IF v_sold + v_held >= v_limit THEN
    RAISE EXCEPTION 'offer stock held by other checkouts' USING ERRCODE = 'OFS02';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS offer_purchases_enforce_stock ON public.offer_purchases;
CREATE TRIGGER offer_purchases_enforce_stock
  BEFORE INSERT ON public.offer_purchases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_offer_stock();

-- Self-check: the post-state in the catalog, never this file's text.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'sale_offers' AND column_name = 'stock_limit') THEN
    RAISE EXCEPTION 'mig 850: sale_offers.stock_limit missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.offer_purchases'::regclass
                   AND tgname = 'offer_purchases_enforce_stock' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'mig 850: the stock trigger is not enabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.offer_stock_counts(uuid[], text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.offer_stock_counts(uuid[], text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 850: offer_stock_counts is executable by a client role';
  END IF;
END $$;
