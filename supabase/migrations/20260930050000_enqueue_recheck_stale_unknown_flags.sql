-- Re-check every listing still carrying a stale "unknown suppression category"
-- flag, so the admin review list reflects the fixed classifier.
--
-- listing_issue_unknown_flagged is stored state, recomputed only when a check
-- runs. The locator-vs-reason fix went live 2026-09-30 23:36 UTC; the flags on
-- these rows were written by checks that ran at 09:05 UTC and earlier, so the
-- panel keeps showing {LISTING} until each row is re-read. The panel filters by
-- marketplace, which is why it reported "(1)" on US while BR and CA hold more.
--
-- NOT fixed with an UPDATE. Clearing the stored flag by hand would empty the
-- list without proving the classifier change works, and would also wipe the one
-- signal that says whether Amazon still reports the issue at all. A real
-- re-check either clears the flag (locator-only, as expected) or keeps it with a
-- reason worth reading -- and code 18977, "Counterfeit without a Test Buy", is
-- specifically something these re-reads may now surface for the first time.
--
-- Queued rather than called directly: check-pricing-suppression-item is
-- internal-only, and a direct net.http_post is refused (403 Forbidden from its
-- own guard; earlier attempts were refused at the gateway instead -- see
-- 20260922012000). pricing-suppression-worker, cron #122 every minute, holds the
-- right credentials and drains 30 per run, so a few hundred rows clear within
-- the hour. Priority 1 puts them ahead of the nightly enqueue.

DO $p$
DECLARE v_uid uuid; n_flagged int; n_queued int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO n_flagged
  FROM public.repricer_assignments
  WHERE user_id = v_uid AND listing_issue_unknown_flagged = true;
  RAISE NOTICE 'listings carrying a stale review flag: %', n_flagged;

  WITH ins AS (
    INSERT INTO public.pricing_suppression_check_queue (user_id, asin, sku, marketplace, status, priority)
    SELECT a.user_id, a.asin, a.sku, a.marketplace, 'pending', 1
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid
      AND a.listing_issue_unknown_flagged = true
      AND NOT EXISTS (
        SELECT 1 FROM public.pricing_suppression_check_queue q
        WHERE q.user_id = a.user_id AND q.sku = a.sku AND q.marketplace = a.marketplace
          AND q.status IN ('pending','running'))
    RETURNING 1)
  SELECT count(*) INTO n_queued FROM ins;

  RAISE NOTICE 'queued for re-check at priority 1: % (worker drains 30/min)', n_queued;
END
$p$;
