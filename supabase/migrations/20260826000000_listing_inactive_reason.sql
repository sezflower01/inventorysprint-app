-- Record WHY a listing is not buyable, not just THAT it is.
--
-- `is_listing_inactive_not_buyable` and `listing_inactive_statuses` already tell
-- us a listing lost BUYABLE and kept only DISCOVERABLE -- which is exactly what
-- Seller Central labels "Inactive". What they do not say is the reason, so the
-- only way to find out was to open Seller Central and read "Review blocked
-- reason" by hand.
--
-- Amazon already sends it. pricing-suppression-core requests
-- `includedData: 'summaries,issues'` and binds the result to `issues_seen`, but
-- the not-buyable branch only ever stored the status array -- the issues were
-- used solely by classifyIssues() for the PRICING suppression path. A
-- counterfeit/IP block produces an issues[] entry with severity ERROR and no
-- INVALID_PRICE category, so classifyIssues ignored it and the reason was
-- dropped on the floor.
--
-- Prompted by B0FTMPT33K on 2026-08-25: blocked by Amazon pending a counterfeit
-- appeal, correctly detected as not-buyable on 08-22 (Seller Central said
-- 08-20), but the app could only show it as paused with no explanation.
--
-- Deliberately separate from the pricing_suppression_raw_* columns rather than
-- reusing them. A price suppression and an authenticity block are different
-- conditions with different remedies -- repricing down clears the first and
-- does nothing for the second -- and conflating them in one field would make
-- both unreadable.

ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS listing_inactive_reason_code text,
  ADD COLUMN IF NOT EXISTS listing_inactive_reason_message text;

COMMENT ON COLUMN public.repricer_assignments.listing_inactive_reason_code IS
  'SP-API issues[].code for the ERROR that made this listing non-buyable. Null when Amazon returned no issue (e.g. Fix Price Alert deactivations carry no issues[] entry).';

COMMENT ON COLUMN public.repricer_assignments.listing_inactive_reason_message IS
  'SP-API issues[].message, truncated to 500 chars. The human-readable text Seller Central shows as "Review blocked reason".';
