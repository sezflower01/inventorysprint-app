/**
 * ════════════════════════════════════════════════════════════════════
 * CANONICAL REFUND MATH — single source of truth for every UI surface.
 * ════════════════════════════════════════════════════════════════════
 *
 * Before this helper existed, three formulas coexisted in production and
 * produced three different dollar amounts for the SAME refunded order
 * (verified 2026-06-17, .lovable/architecture-audit.md §1.2):
 *
 *   • PeriodStatsBlocks paths       → GROSS (principal only)        — $101.84
 *   • live-sales-core (Deno cache)  → NET, 6-col formula            — $92.06*
 *   • LiveSales.tsx / Mobile        → NET, 12-col formula           — $92.06
 *
 * This module is now THE only place that knows how to turn FEC refund
 * rows into the seller's true cash impact. Every UI surface must call
 * `computeNetRefundFromFecRows` (or one of its named wrappers).
 *
 * FEC sign conventions (mirrors Amazon's settlement JSON):
 *   • r.refunds                   ≤ 0 (seller paid buyer back)        → cost
 *   • r.referral_fees             ≤ 0 (Amazon credited seller back)   → credit
 *   • r.fba_fees                  ≤ 0 (Amazon credited seller back)   → credit
 *   • r.promotional_rebate_refunds ≤ 0 (rebate also refunded)         → cost
 *   • r.shipping_credit_refunds   ≤ 0                                  → cost
 *   • r.shipping_chargeback_refund ≤ 0                                 → cost
 *   • r.gift_wrap_credit_refunds  ≤ 0                                  → cost
 *
 * Refund administration retention is NOT in FEC — Amazon retains
 * `min($5.00, 20% × |referral_fee|)` per refund. We synthesize it.
 *
 * The canonical formula (signed sum, then |·|):
 *
 *   netCostToSeller = principal
 *                   + promoRefunds
 *                   + shippingCreditRefunds
 *                   + shippingChargebackRefund
 *                   + giftWrapCreditRefunds
 *                   + referralFeesSigned          ← credit (negative) reduces cost
 *                   + adminRetention               ← always positive cost
 *                   + (optional 12-col extras: fba_fees, fba_customer_return_fees,
 *                      other_fees, digital_services_fee,
 *                      reversal_reimbursement)
 *                   − restocking_fee                ← stored positive but IS a
 *                      credit (buyer-charged penalty passed to the seller), so
 *                      it is the one extra that is subtracted. See below.
 *
 * Two modes:
 *   `simple` (6-col)  — used by live-sales-core daily-cache producer.
 *                        Preserves bit-identical output of the legacy
 *                        Deno path so cached `live_sales_summary` rows
 *                        don't shift under a stabilization-phase refactor.
 *   `full` (12-col)   — used by every interactive surface (LiveSales,
 *                        MobileLiveSales, PeriodStatsBlocks). Includes
 *                        FBA refund credits and other refund-side fee
 *                        movements that hit the seller's payout.
 *
 * Migration plan: once `live_sales_summary` has been re-cached on the
 * full formula, the `simple` mode can be deleted. Telemetry graduation
 * rule lives in PeriodStatsBlocks.tsx (`__refundGrossWarned`).
 */

export interface FecRefundRow {
  amazon_order_id?: string | null;
  asin?: string | null;
  marketplace?: string | null;
  event_date?: string | null;
  refunds?: number | string | null;
  promotional_rebate_refunds?: number | string | null;
  shipping_credit_refunds?: number | string | null;
  shipping_chargeback_refund?: number | string | null;
  gift_wrap_credit_refunds?: number | string | null;
  referral_fees?: number | string | null;
  // 12-col extras (full mode only)
  fba_fees?: number | string | null;
  fba_customer_return_fees?: number | string | null;
  restocking_fee?: number | string | null;
  other_fees?: number | string | null;
  digital_services_fee?: number | string | null;
  reversal_reimbursement?: number | string | null;
}

export type RefundFormulaMode = 'simple' | 'full';

export interface CanonicalRefundTotals {
  /** Positive: principal refunded to the buyer across all events. */
  principalRefunded: number;
  /** Positive: referral fee Amazon credited back to the seller. */
  referralFeeCreditPositive: number;
  /** Positive: per-event admin retention `min($5, 20%·|referral|)` summed. */
  refundAdminRetention: number;
  /** Positive: net cash impact to the seller (the canonical refund cost). */
  refundCostNet: number;
  /** Count of refund events processed. */
  refundEventCount: number;
  /** Distinct order ids that contained at least one refund event. */
  refundOrderCount: number;
  /** Mode that was applied. */
  mode: RefundFormulaMode;
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Compute canonical refund totals from a list of FEC refund rows.
 *
 * FEC sign conventions (verified 2026-06-17 against production data):
 *   • `refunds`        — stored POSITIVE  (principal refunded to buyer = cost)
 *   • `referral_fees`  — stored NEGATIVE  (Amazon credited seller back)
 *   • `fba_fees` etc.  — stored NEGATIVE when refund-side credits
 *   • `*_refunds` cols — stored POSITIVE  (additional refund-side cost)
 *
 * Per-event signed sum yields a positive cost-to-seller number directly.
 * Pure function — safe to call from frontend or Deno edge.
 */
export function computeNetRefundFromFecRows(
  rows: FecRefundRow[] | null | undefined,
  mode: RefundFormulaMode = 'full'
): CanonicalRefundTotals {
  const out: CanonicalRefundTotals = {
    principalRefunded: 0,
    referralFeeCreditPositive: 0,
    refundAdminRetention: 0,
    refundCostNet: 0,
    refundEventCount: 0,
    refundOrderCount: 0,
    mode,
  };
  if (!rows || rows.length === 0) return out;
  const orderSet = new Set<string>();
  let signedTotal = 0;

  for (const r of rows) {
    const principal = n(r.refunds);                     // POSITIVE cost
    const promo = n(r.promotional_rebate_refunds);
    const shipCred = n(r.shipping_credit_refunds);
    const shipCharge = n(r.shipping_chargeback_refund);
    const giftWrap = n(r.gift_wrap_credit_refunds);
    const referralSigned = n(r.referral_fees);          // NEGATIVE credit
    const referralPositive = Math.abs(referralSigned);
    const admin = Math.min(5.0, referralPositive * 0.20);

    let signedSum =
      principal + promo + shipCred + shipCharge + giftWrap +
      referralSigned + admin;

    if (mode === 'full') {
      signedSum +=
        n(r.fba_fees) +
        n(r.fba_customer_return_fees) +
        // ⚠️ SUBTRACTED, unlike every other term in this block.
        //
        // This sum follows the convention documented above: positive = cost.
        // restocking_fee is the one FEC column stored POSITIVE while being a
        // CREDIT -- Amazon charges the restocking penalty to the returning
        // BUYER (15/20/50% of item price), withholds it from their refund and
        // passes it to the seller. Verified 2026-11-11 against the stored
        // signs: on 5,254 refund rows `refunds` is positive 4742/0 (cost) and
        // the credits `referral_fees` (0/4742) and `other_fees` (0/520) are
        // negative, so the convention holds for everything except this column.
        //
        // Adding it charged the seller for money kept, inflating refund cost by
        // 2x the fee -- $380.66 lifetime on $190.33 of credits. Untested until
        // now: every case in refundGrossNetDrift.test.ts set it to 0.
        //
        // Do NOT flip the stored sign instead: plModel.ts carries
        // restocking_fee in INCOME_ROWS and needs it positive, so the data is
        // right and only cost-convention consumers were wrong.
        -n(r.restocking_fee) +
        n(r.other_fees) +
        n(r.digital_services_fee) +
        n(r.reversal_reimbursement);
    }

    out.principalRefunded += Math.abs(principal);       // robust to sign drift
    out.referralFeeCreditPositive += referralPositive;
    out.refundAdminRetention += admin;
    signedTotal += signedSum;
    out.refundEventCount += 1;
    if (r.amazon_order_id) orderSet.add(String(r.amazon_order_id));
  }

  // Safety clamp at the SUM level (not per-event) so partial credits in a
  // multi-event order can still offset costs from another event.
  out.refundCostNet = Math.max(0, signedTotal);
  out.refundOrderCount = orderSet.size;

  const r2 = (x: number) => Math.round(x * 100) / 100;
  out.principalRefunded = r2(out.principalRefunded);
  out.referralFeeCreditPositive = r2(out.referralFeeCreditPositive);
  out.refundAdminRetention = r2(out.refundAdminRetention);
  out.refundCostNet = r2(out.refundCostNet);
  return out;
}

/**
 * Convenience: project canonical totals into the `RefundBreakdown` shape
 * consumed by `computePeriodTotals` (see src/lib/sales/periodTotals.ts).
 *
 * The receiving formula in periodTotals.ts is:
 *   refundCostTotal = refundedAmount − refundedReferralFee + refundAdminRetention
 *
 * So we pass:
 *   refundedAmount       = principalRefunded
 *   refundedReferralFee  = referralFeeCreditPositive  (subtracted → reduces cost)
 *   refundAdminRetention = refundAdminRetention       (added → increases cost)
 *
 * Yielding refundCostTotal exactly equal to refundCostNet for the
 * 6-column components (full-mode 12-col extras flow only through
 * refundCostNet — callers wanting those should pass refundCostNet
 * directly as refundedAmount with the other two fields zero).
 */
export function toRefundBreakdown(totals: CanonicalRefundTotals) {
  return {
    refundedAmount: totals.principalRefunded,
    refundedReferralFee: totals.referralFeeCreditPositive,
    refundedOtherFees: 0,
    refundAdminRetention: totals.refundAdminRetention,
    refundEventCount: totals.refundEventCount,
  };
}
