/**
 * The International Marketplace Profit panel's taxonomy, as plain data.
 *
 * These three arrays live here rather than inside the component for one
 * reason: the test that pins them against plModel (see
 * src/lib/__tests__/internationalPanelTaxonomy.test.ts) runs in Vitest's node
 * environment, and this repo has no jsdom or happy-dom installed. Importing
 * the component pulls in src/integrations/supabase/client.ts, which touches
 * `localStorage` at module scope and throws ReferenceError before a single
 * assertion runs. A pure module has no such dependency, so the guard can
 * actually execute.
 */
// Same row taxonomy MonthlyPLBreakdown.tsx uses (INCOME_ROWS / EXPENSE_ROWS),
// applied per marketplace instead of per account. Every field here comes
// from get_monthly_pl_breakdown, which sources financial_events_cache --
// per-transaction, marketplace-tagged Amazon events. Nothing here is
// company overhead: Operating Expenses (Salary/Rent/Subscriptions/etc.) and
// Inventory Damage & Loss (dispositions/write-offs) are deliberately
// excluded because neither has a marketplace column in this account's data
// at all -- there's nothing to attribute. CA/MX/BR sell via Remote
// Fulfillment from the same US-purchased inventory, so there's no separate
// international operation to carry its own overhead anyway.
// Mirrors MonthlyPLBreakdown.tsx's INCOME_ROWS/EXPENSE_ROWS (the canonical
// taxonomy) -- BY HAND, so it can and did fall behind; see compensated_clawback
// below -- restocking_fee and promotional_rebate_refunds are
// both credits: a restocking fee is charged to the RETURNING CUSTOMER and
// kept by the seller (see fetch-profit-loss/index.ts's own comment on
// processRefundEventToCache), and a promotional-rebate refund is Amazon
// reversing an over-applied promo back to the seller. Getting either one
// backwards understates international profit.
export const INCOME_KEYS = ["sales", "reimbursements", "shipping_credits", "gift_wrap_credits", "promotional_rebate_refunds", "restocking_fee", "other_income", "liquidations", "warehouse_lost", "warehouse_damage", "shipping_chargeback_refund"] as const;
export const INCOME_DEDUCTION_KEYS = ["refunds", "shipping_credit_refunds", "gift_wrap_credit_refunds", "promotional_rebates"] as const;
// compensated_clawback added 2026-10-23. It was missing because when this list
// was written the key sat in plModel MEMO_ROWS as display-only, so there was
// nothing to mirror -- note hrr_non_apparel, its old memo-row neighbour, IS
// here. Clawbacks became a real EXPENSE_ROWS line once fetch-profit-loss began
// storing them (it had silently dropped every one, 0 rows across 22 months),
// and without this entry international profit would keep ignoring them.
//
// This is exactly the hazard the comment above warns about: the list is a COPY
// of plModel's taxonomy, so plModel changing does not update it. Any future
// EXPENSE_ROWS addition has to be mirrored here by hand.
//
// Mirroring is now PINNED by src/lib/__tests__/internationalPanelTaxonomy.test.ts,
// which diffs these three arrays against plModel's INCOME_ROWS/EXPENSE_ROWS and
// fails on any key present in one and not the other. That is why they are
// exported. Verified live on 2026-11-11: the lists were in sync, and a
// data-driven sweep of every numeric financial_events_cache column with a
// non-zero non-US 2026 total found nothing outside them except
// sales_tax_collected ($27.59) and marketplace_facilitator_tax ($6.66), which
// sit below Net Profit by design.
//
// ── ONE KNOWN LIMIT, NOT A BUG IN THIS PANEL ──────────────────────────────
//
// Sales come from financial_events_cache.event_date (when Amazon POSTED the
// event); COGS from sales_orders.order_date (when the order was PLACED). An
// order that straddles 1 January therefore books its revenue in one year and
// its cost in the other. Measured 2026-11-11 for CA/MX/BR: 45 orders carry
// $1,526.26 of 2026 revenue whose $554.90 of COGS sits in 2025, and no 2026
// order settles after 2026 -- so 2026 international profit is OVERSTATED by
// $554.90, about 13% of it. 2025 received only $17.16 the same way, so this
// does not wash out year to year at current volumes.
//
// Left alone deliberately: the main P&L and every COGS surface share this date
// basis, so changing it here alone would make this panel disagree with the
// report above it. Fixing it properly means choosing ONE basis for the whole
// P&L, which is a decision about the accounts, not a bug fix.
export const AMAZON_FEE_KEYS = ["referral_fees", "variable_closing_fees", "fixed_closing_fees", "fba_fees", "fba_customer_return_fees", "fba_inbound_fees", "fba_inbound_convenience_fee", "fba_storage_fees", "fba_removal_fees", "fba_disposal_fees", "fba_long_term_storage_fees", "digital_services_fee", "other_fees", "liquidations_brokerage_fee", "re_commerce_grading_charge", "hrr_non_apparel", "shipping_chargeback", "compensated_clawback"] as const;
