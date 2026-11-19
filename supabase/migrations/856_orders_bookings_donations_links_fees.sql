-- 856 — ORDERSMORE.1: paid class bookings, donations, staff payment links and
-- class fees appear in orders.
--
-- Orders PR 3 of the step 4 design (Richard's decisions 19 Nov 2026), the same
-- pattern as mig 855:
--   * orders.source_type also takes 'class_booking', 'donation',
--     'staff_payment_link' and 'class_fee'.
--   * A trigger on each table projects a PAID row into orders, one order per
--     row (UNIQUE (source_type, source_id)), whichever path marked it paid:
--       class_booking_requests  payment_status 'paid' (Revolut or Stripe)
--       donations               status 'paid' (Revolut or Stripe)
--       staff_payment_links     status 'paid' (un1t.online; the CRM sent it)
--       class_fees              status 'charged' (un1t.online; the CRM charged it)
--   * The trigger only inserts the order or fills in a contact or payment
--     reference it did not know. It never touches status or refunds, with ONE
--     exception: a donation marked refunded outside the ledger (the record-only
--     "Mark as refunded" button, or a Stripe refund webhook) marks its
--     still-completed order refunded too, so the two never disagree.
--   * staff_payment_links and class_fees carry no email; the order takes the
--     contact's (orders.contact_email is NOT NULL, so '' when there is none).
--   * A projection failure never fails the write it rides on: it is recorded
--     in error_events (route_type 'db_trigger') and the write stands.
--   * Existing paid rows are backfilled.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.orders DROP CONSTRAINT orders_source_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_source_type_check
  CHECK (source_type = ANY (ARRAY['race_registration'::text, 'car_deposit'::text, 'trial_purchase'::text,
    'offer_purchase'::text, 'class_booking'::text, 'donation'::text, 'staff_payment_link'::text, 'class_fee'::text]));

-- One writer for all four: insert the order, or fill in a missing contact or
-- payment reference. Never status or refund columns.
CREATE FUNCTION private.upsert_projected_order(
  p_source_type text, p_source_id uuid, p_location_id uuid, p_contact_id uuid,
  p_email text, p_phone text, p_name text, p_amount_cents integer, p_currency text,
  p_provider text, p_ref text, p_connected_account_id text, p_paid_at timestamptz, p_metadata jsonb
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.orders (location_id, organization_id, source_type, source_id, contact_id,
    contact_email, contact_phone, contact_name, amount_cents, currency, status,
    payment_provider, payment_provider_ref, connected_account_id, completed_at, metadata,
    created_at, updated_at)
  SELECT p_location_id, l.organization_id, p_source_type, p_source_id, p_contact_id,
    COALESCE(p_email, ''), NULLIF(btrim(p_phone), ''), NULLIF(btrim(p_name), ''),
    p_amount_cents, COALESCE(p_currency, 'EUR'), 'completed',
    p_provider, p_ref, p_connected_account_id, p_paid_at, p_metadata,
    p_paid_at, now()
  FROM public.locations l WHERE l.id = p_location_id
  ON CONFLICT (source_type, source_id) DO UPDATE
    SET contact_id = COALESCE(public.orders.contact_id, EXCLUDED.contact_id),
        payment_provider_ref = COALESCE(public.orders.payment_provider_ref, EXCLUDED.payment_provider_ref),
        updated_at = now()
    WHERE public.orders.contact_id IS NULL OR public.orders.payment_provider_ref IS NULL;
$$;

CREATE FUNCTION private.record_order_projection_failure(p_fn text, p_source text, p_id uuid, p_state text, p_msg text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.error_events (route_path, route_type, name, message)
  VALUES ('db:' || p_fn, 'db_trigger', 'order_projection_failed',
    left(format('%s %s: %s %s', p_source, p_id, p_state, p_msg), 500));
$$;

-- ── class_booking_requests → orders ─────────────────────────────────────
CREATE FUNCTION private.project_class_booking_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM 'paid' OR NEW.payment_provider IS NULL OR COALESCE(NEW.amount_cents, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM private.upsert_projected_order('class_booking', NEW.id, NEW.location_id, NEW.contact_id,
      NEW.customer_email, NEW.customer_phone, NEW.customer_name, NEW.amount_cents, NEW.currency,
      NEW.payment_provider, NEW.payment_provider_ref, NEW.connected_account_id, NEW.updated_at,
      jsonb_build_object('class_name', NEW.class_name, 'starts_at', NEW.starts_at));
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.record_order_projection_failure('project_class_booking_order', 'class_booking', NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER class_booking_requests_project_order
  AFTER INSERT OR UPDATE OF payment_status, contact_id, payment_provider_ref ON public.class_booking_requests
  FOR EACH ROW EXECUTE FUNCTION private.project_class_booking_order();

-- ── donations → orders ──────────────────────────────────────────────────
CREATE FUNCTION private.project_donation_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF NEW.status IN ('paid', 'refunded') AND NEW.paid_at IS NOT NULL THEN
      PERFORM private.upsert_projected_order('donation', NEW.id, NEW.location_id, NEW.contact_id,
        NEW.donor_email, NULL, NEW.donor_name, NEW.amount_cents, NEW.currency,
        NEW.payment_provider, NEW.payment_provider_ref, NEW.connected_account_id, NEW.paid_at,
        jsonb_build_object('race_event_id', NEW.race_event_id));
    END IF;
    -- Refunded outside the ledger: the order follows, once.
    IF NEW.status = 'refunded' AND OLD IS DISTINCT FROM NULL AND OLD.status IS DISTINCT FROM 'refunded' THEN
      UPDATE public.orders
        SET status = 'refunded',
            refunded_amount_cents = GREATEST(COALESCE(refunded_amount_cents, 0), amount_cents),
            refunded_at = COALESCE(NEW.refunded_at, now()),
            updated_at = now()
        WHERE source_type = 'donation' AND source_id = NEW.id AND status = 'completed';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.record_order_projection_failure('project_donation_order', 'donation', NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER donations_project_order
  AFTER INSERT OR UPDATE OF status, paid_at, contact_id, payment_provider_ref ON public.donations
  FOR EACH ROW EXECUTE FUNCTION private.project_donation_order();

-- ── staff_payment_links → orders ────────────────────────────────────────
CREATE FUNCTION private.project_staff_payment_link_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF NEW.status <> 'paid' OR COALESCE(NEW.price_cents, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT email, phone, name INTO c FROM public.contacts WHERE id = NEW.contact_id;
    PERFORM private.upsert_projected_order('staff_payment_link', NEW.id, NEW.location_id, NEW.contact_id,
      c.email, c.phone, c.name, NEW.price_cents, 'EUR',
      'un1t_online', NEW.paid_transaction_id, NULL, COALESCE(NEW.paid_at, NEW.updated_at),
      jsonb_build_object('product_title', NEW.product_title, 'un1t_product_id', NEW.un1t_product_id));
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.record_order_projection_failure('project_staff_payment_link_order', 'staff_payment_link', NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_payment_links_project_order
  AFTER INSERT OR UPDATE OF status, paid_transaction_id ON public.staff_payment_links
  FOR EACH ROW EXECUTE FUNCTION private.project_staff_payment_link_order();

-- ── class_fees → orders ─────────────────────────────────────────────────
CREATE FUNCTION private.project_class_fee_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF NEW.status <> 'charged' OR NEW.amount_cents <= 0 THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT email, phone, name INTO c FROM public.contacts WHERE id = NEW.contact_id;
    PERFORM private.upsert_projected_order('class_fee', NEW.id, NEW.location_id, NEW.contact_id,
      c.email, c.phone, c.name, NEW.amount_cents, NEW.currency,
      'un1t_online', NEW.un1t_transaction_id, NULL, COALESCE(NEW.charged_at, NEW.updated_at),
      jsonb_build_object('class_title', NEW.class_title, 'starts_at', NEW.starts_at, 'kind', NEW.kind));
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.record_order_projection_failure('project_class_fee_order', 'class_fee', NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER class_fees_project_order
  AFTER INSERT OR UPDATE OF status, contact_id, un1t_transaction_id ON public.class_fees
  FOR EACH ROW EXECUTE FUNCTION private.project_class_fee_order();

REVOKE EXECUTE ON FUNCTION private.upsert_projected_order(text, uuid, uuid, uuid, text, text, text, integer, text, text, text, text, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.record_order_projection_failure(text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.project_class_booking_order() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.project_donation_order() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.project_staff_payment_link_order() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.project_class_fee_order() FROM PUBLIC, anon, authenticated;

-- ── backfill ────────────────────────────────────────────────────────────
SELECT private.upsert_projected_order('class_booking', r.id, r.location_id, r.contact_id,
  r.customer_email, r.customer_phone, r.customer_name, r.amount_cents, r.currency,
  r.payment_provider, r.payment_provider_ref, r.connected_account_id, r.updated_at,
  jsonb_build_object('class_name', r.class_name, 'starts_at', r.starts_at))
FROM public.class_booking_requests r
WHERE r.payment_status = 'paid' AND r.payment_provider IS NOT NULL AND COALESCE(r.amount_cents, 0) > 0;

SELECT private.upsert_projected_order('donation', d.id, d.location_id, d.contact_id,
  d.donor_email, NULL, d.donor_name, d.amount_cents, d.currency,
  d.payment_provider, d.payment_provider_ref, d.connected_account_id, d.paid_at,
  jsonb_build_object('race_event_id', d.race_event_id))
FROM public.donations d
WHERE d.status IN ('paid', 'refunded') AND d.paid_at IS NOT NULL;

-- Donations already refunded: their orders say so.
UPDATE public.orders o
  SET status = 'refunded', refunded_amount_cents = o.amount_cents,
      refunded_at = COALESCE(d.refunded_at, now()), updated_at = now()
  FROM public.donations d
  WHERE o.source_type = 'donation' AND o.source_id = d.id AND d.status = 'refunded' AND o.status = 'completed';

SELECT private.upsert_projected_order('staff_payment_link', s.id, s.location_id, s.contact_id,
  c.email, c.phone, c.name, s.price_cents, 'EUR',
  'un1t_online', s.paid_transaction_id, NULL, COALESCE(s.paid_at, s.updated_at),
  jsonb_build_object('product_title', s.product_title, 'un1t_product_id', s.un1t_product_id))
FROM public.staff_payment_links s
LEFT JOIN public.contacts c ON c.id = s.contact_id
WHERE s.status = 'paid' AND COALESCE(s.price_cents, 0) > 0;

SELECT private.upsert_projected_order('class_fee', f.id, f.location_id, f.contact_id,
  c.email, c.phone, c.name, f.amount_cents, f.currency,
  'un1t_online', f.un1t_transaction_id, NULL, COALESCE(f.charged_at, f.updated_at),
  jsonb_build_object('class_title', f.class_title, 'starts_at', f.starts_at, 'kind', f.kind))
FROM public.class_fees f
LEFT JOIN public.contacts c ON c.id = f.contact_id
WHERE f.status = 'charged' AND f.amount_cents > 0;

COMMIT;
