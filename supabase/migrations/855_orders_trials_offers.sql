-- 855 — ORDERSTRIALS.1: paid trials and offer sales appear in orders.
--
-- orders held only race entries and car deposits, so a paid /trial or an
-- /offers sale could not be found on the Orders page or refunded from the CRM
-- (step 4 orders design, Richard's decisions 19 Nov 2026: owners and masters
-- refund with a reason; un1t.online money appears only for sales the CRM
-- started; backfill everything).
--
-- Now:
--   * orders.source_type also takes 'trial_purchase' and 'offer_purchase'.
--   * A trigger on each table projects a PAID row into orders (one order per
--     row: UNIQUE (source_type, source_id)), whichever path marked it paid:
--     the Revolut and Stripe webhooks, the reconcile cron, the un1t.online
--     settle sweep, the offer purchase sweep. Unpaid checkouts are not orders.
--   * Offer sales made in the un1t.online app or at the desk (origin
--     'off_page') are not orders: the CRM did not start them.
--   * The trigger only ever INSERTS the order or fills in what it did not know
--     yet (the contact, the payment reference). It never touches the order's
--     status or refund columns, which the refund ledger (mig 853) owns.
--   * A projection failure never fails the payment write it rides on: it is
--     recorded in error_events (route_type 'db_trigger') and the payment
--     stands. Re-running the backfill INSERT below puts any missing order in.
--   * Existing paid rows are backfilled.
--
-- Apply before the code that labels these orders deploys (the labels fall
-- back to the raw source_type, so either order works).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.orders DROP CONSTRAINT orders_source_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_source_type_check
  CHECK (source_type = ANY (ARRAY['race_registration'::text, 'car_deposit'::text, 'trial_purchase'::text, 'offer_purchase'::text]));

-- ── trial_purchases → orders ────────────────────────────────────────────
CREATE FUNCTION private.project_trial_purchase_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.paid_at IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO public.orders (location_id, organization_id, source_type, source_id, contact_id,
      contact_email, contact_phone, contact_name, amount_cents, currency, status,
      payment_provider, payment_provider_ref, connected_account_id, completed_at, metadata,
      created_at, updated_at)
    SELECT NEW.location_id, l.organization_id, 'trial_purchase', NEW.id, NEW.contact_id,
      NEW.customer_email, NEW.customer_phone,
      COALESCE(NULLIF(btrim(NEW.customer_name), ''), NULLIF(btrim(concat_ws(' ', NEW.first_name, NEW.last_name)), '')),
      NEW.amount_cents, COALESCE(NEW.currency, 'EUR'), 'completed',
      NEW.payment_provider, NEW.payment_provider_ref, NEW.connected_account_id, NEW.paid_at,
      jsonb_build_object('product_name', NEW.product_name),
      NEW.paid_at, now()
    FROM public.locations l WHERE l.id = NEW.location_id
    ON CONFLICT (source_type, source_id) DO UPDATE
      SET contact_id = COALESCE(public.orders.contact_id, EXCLUDED.contact_id),
          payment_provider_ref = COALESCE(public.orders.payment_provider_ref, EXCLUDED.payment_provider_ref),
          updated_at = now()
      WHERE public.orders.contact_id IS NULL OR public.orders.payment_provider_ref IS NULL;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.error_events (route_path, route_type, name, message)
    VALUES ('db:project_trial_purchase_order', 'db_trigger', 'order_projection_failed',
      left(format('trial_purchase %s: %s %s', NEW.id, SQLSTATE, SQLERRM), 500));
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trial_purchases_project_order
  AFTER INSERT OR UPDATE OF paid_at, contact_id, payment_provider_ref ON public.trial_purchases
  FOR EACH ROW EXECUTE FUNCTION private.project_trial_purchase_order();

-- ── offer_purchases → orders ────────────────────────────────────────────
CREATE FUNCTION private.project_offer_purchase_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ref text := COALESCE(NEW.revolut_order_id, NEW.un1t_transaction_id);
BEGIN
  IF NEW.state <> 'paid' OR NEW.origin <> 'page' THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO public.orders (location_id, organization_id, source_type, source_id, contact_id,
      contact_email, contact_phone, contact_name, amount_cents, currency, status,
      payment_provider, payment_provider_ref, completed_at, metadata, created_at, updated_at)
    SELECT NEW.location_id, l.organization_id, 'offer_purchase', NEW.id, NEW.contact_id,
      NEW.buyer_email, NULLIF(NEW.buyer_phone, ''), NULLIF(btrim(NEW.buyer_name), ''),
      NEW.amount_cents, COALESCE(NEW.currency, 'EUR'), 'completed',
      NEW.payment_provider, ref, COALESCE(NEW.paid_at, NEW.updated_at),
      jsonb_build_object('offer_id', NEW.offer_id, 'offer_name', o.name),
      COALESCE(NEW.paid_at, NEW.updated_at), now()
    FROM public.locations l
    LEFT JOIN public.sale_offers o ON o.id = NEW.offer_id
    WHERE l.id = NEW.location_id
    ON CONFLICT (source_type, source_id) DO UPDATE
      SET contact_id = COALESCE(public.orders.contact_id, EXCLUDED.contact_id),
          payment_provider_ref = COALESCE(public.orders.payment_provider_ref, EXCLUDED.payment_provider_ref),
          updated_at = now()
      WHERE public.orders.contact_id IS NULL OR public.orders.payment_provider_ref IS NULL;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.error_events (route_path, route_type, name, message)
    VALUES ('db:project_offer_purchase_order', 'db_trigger', 'order_projection_failed',
      left(format('offer_purchase %s: %s %s', NEW.id, SQLSTATE, SQLERRM), 500));
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offer_purchases_project_order
  AFTER INSERT OR UPDATE OF state, contact_id, revolut_order_id, un1t_transaction_id ON public.offer_purchases
  FOR EACH ROW EXECUTE FUNCTION private.project_offer_purchase_order();

REVOKE EXECUTE ON FUNCTION private.project_trial_purchase_order() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.project_offer_purchase_order() FROM PUBLIC, anon, authenticated;

-- ── backfill ────────────────────────────────────────────────────────────
INSERT INTO public.orders (location_id, organization_id, source_type, source_id, contact_id,
  contact_email, contact_phone, contact_name, amount_cents, currency, status,
  payment_provider, payment_provider_ref, connected_account_id, completed_at, metadata,
  created_at, updated_at)
SELECT t.location_id, l.organization_id, 'trial_purchase', t.id, t.contact_id,
  t.customer_email, t.customer_phone,
  COALESCE(NULLIF(btrim(t.customer_name), ''), NULLIF(btrim(concat_ws(' ', t.first_name, t.last_name)), '')),
  t.amount_cents, COALESCE(t.currency, 'EUR'), 'completed',
  t.payment_provider, t.payment_provider_ref, t.connected_account_id, t.paid_at,
  jsonb_build_object('product_name', t.product_name),
  t.paid_at, now()
FROM public.trial_purchases t
JOIN public.locations l ON l.id = t.location_id
WHERE t.paid_at IS NOT NULL
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO public.orders (location_id, organization_id, source_type, source_id, contact_id,
  contact_email, contact_phone, contact_name, amount_cents, currency, status,
  payment_provider, payment_provider_ref, completed_at, metadata, created_at, updated_at)
SELECT p.location_id, l.organization_id, 'offer_purchase', p.id, p.contact_id,
  p.buyer_email, NULLIF(p.buyer_phone, ''), NULLIF(btrim(p.buyer_name), ''),
  p.amount_cents, COALESCE(p.currency, 'EUR'), 'completed',
  p.payment_provider, COALESCE(p.revolut_order_id, p.un1t_transaction_id),
  COALESCE(p.paid_at, p.updated_at),
  jsonb_build_object('offer_id', p.offer_id, 'offer_name', o.name),
  COALESCE(p.paid_at, p.updated_at), now()
FROM public.offer_purchases p
JOIN public.locations l ON l.id = p.location_id
LEFT JOIN public.sale_offers o ON o.id = p.offer_id
WHERE p.state = 'paid' AND p.origin = 'page'
ON CONFLICT (source_type, source_id) DO NOTHING;

COMMIT;
