-- 330 — derive contacts.wa_phone from contacts.phone on insert/update (the forward
-- mechanism that pairs with the one-off backfill in mig 326).
--
-- WHY: wa_phone (the WhatsApp number) was only ever set by a real WhatsApp
-- interaction, never derived from the imported `phone`. mig 326 backfilled the
-- existing rows, but new Glofox imports / manual contacts / signup forms re-open
-- the gap. A BEFORE trigger on contacts catches EVERY write path (no app code can
-- bypass it), so a contact with a valid Irish-mobile `phone` is WhatsApp-reachable
-- from creation.
--
-- Normalisation mirrors mig 326 / src/lib/glofox-sync.js#normalizePhone (then strips
-- '+'): only Irish mobiles (353/0/-trunk 8[35679] + 7 digits) yield a wa_phone;
-- UK / landline / foreign / placeholder numbers leave it NULL. Only fills a NULL/''
-- wa_phone — never overwrites a real one captured from an inbound message.

CREATE OR REPLACE FUNCTION normalize_ie_wa_phone(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE d text;
BEGIN
  IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
  d := regexp_replace(p, '[^0-9]', '', 'g');
  IF d LIKE '00%' THEN d := substr(d, 3); END IF;             -- drop intl 00 prefix
  IF    d ~ '^3538[35679][0-9]{7}$' THEN RETURN d;             -- already E.164 (no +)
  ELSIF d ~ '^08[35679][0-9]{7}$'   THEN RETURN '353' || substr(d, 2);  -- 0-trunk national
  ELSIF d ~ '^8[35679][0-9]{7}$'    THEN RETURN '353' || d;    -- 9-digit, no trunk
  END IF;
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION derive_wa_phone()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.wa_phone IS NULL OR NEW.wa_phone = '') THEN
    NEW.wa_phone := normalize_ie_wa_phone(NEW.phone);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS derive_wa_phone_trigger ON contacts;
CREATE TRIGGER derive_wa_phone_trigger
  BEFORE INSERT OR UPDATE OF phone ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION derive_wa_phone();

COMMENT ON FUNCTION normalize_ie_wa_phone(text) IS
  'Normalise an Irish mobile phone string to a WhatsApp wa_phone (E.164, no +). NULL for non-IE-mobile / invalid. Mirrors mig 326 + glofox-sync.normalizePhone.';
