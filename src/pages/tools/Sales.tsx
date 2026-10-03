import LiveSales from "./LiveSales";
import RestoreMissingOrdersDialog from "@/components/sales/RestoreMissingOrdersDialog";
import AsinProfitLookup from "@/components/sales/AsinProfitLookup";

/**
 * Sales Report = Live Sales (exact same totals/UI/source). All breakdown
 * sections (Refunds, Cancelled Orders, Fees & Credits) now live INSIDE
 * LiveSales so both /tools/live-sales and /tools/sales show identical data.
 *
 * RestoreMissingOrdersDialog is mounted here, and only here, deliberately.
 *
 * It replays the Amazon Orders API over an explicit start/end date and inserts
 * whatever is missing into sales_orders -- the same `{ startDate, endDate }`
 * path that ran on 2026-08-20. Until now the component existed but was imported
 * by nothing, so the only reachable ways to trigger a dated resync were the P&L
 * parity banner (range auto-derived from detected gaps, not choosable) and
 * AmazonConnect's auto-sync (a hardcoded TWO-YEAR window). Neither can target a
 * single day, which is what recovering a specific date -- or safely exercising a
 * change to the ingest path -- actually needs.
 *
 * Mounted on /tools/sales rather than inside LiveSales itself so it does NOT
 * also appear on /tools/repricer/live-sales, which renders the same component.
 * The dialog renders null for non-admins, so this adds nothing for other users.
 *
 * AsinProfitLookup is here for the same reason it is not on the P&L: it answers
 * "what did this ASIN earn between these dates" from sales_orders, which is the
 * source this page already shows. The P&L reads financial_events_cache, whose
 * rows carry no asin at all, so the question is unanswerable there.
 */
export default function Sales() {
  return (
    <>
      <LiveSales title="Sales Report" />
      <div className="container mx-auto px-4 pb-4 max-w-6xl">
        <AsinProfitLookup />
      </div>
      <div className="container mx-auto px-4 pb-10 max-w-6xl flex justify-end">
        <RestoreMissingOrdersDialog />
      </div>
    </>
  );
}
