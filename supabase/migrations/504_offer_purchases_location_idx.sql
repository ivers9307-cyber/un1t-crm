-- OFFERS.1b — advisor fix: cover the offer_purchases.location_id FK.
-- (state, location_id) led with state so it didn't cover the FK; flip the
-- column order — the fulfilment-queue query filters on both, and
-- (location_id, state) additionally serves plain location lookups.

drop index offer_purchases_state_loc;
create index offer_purchases_loc_state on offer_purchases (location_id, state);
