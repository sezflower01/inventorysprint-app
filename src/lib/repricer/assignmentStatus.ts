/**
 * Global repricer assignment status — Phase 1 of architectural fix.
 *
 * Rule: "Paused" means the SELLER manually paused. Nothing else.
 * Everything else gets its own distinct label so the user can tell
 * a manual pause apart from a missing rule, missing inventory, an
 * inactive Amazon listing, stale international quantities, etc.
 *
 * Inputs come straight from `repricer_assignments` joined with the
 * matching inventory row (matched by user_id + marketplace + asin + sku
 * upstream — this helper does NOT match on ASIN alone).
 *
 * Phase 1 adds new fact fields (amazon_listing_state, inventory_confidence,
 * intl_qty_confidence, auto_suspended_reason, inbound). All optional — when
 * absent we keep the legacy behavior, so existing call sites are safe.
 */

export type AssignmentStatusKind =
  | "active"                                   // Green heartbeat
  | "no_rule"                                  // rule_id is null
  | "no_inventory"                             // no matching inventory row (truly terminal)
  | "auto_suspended_no_stock"                  // 0 across available/reserved/inbound + not active
  | "auto_suspended_inbound_only_inactive"     // 0 available, inbound > 0, listing not active
  | "blocked_not_buyable"                       // Amazon dropped BUYABLE — listing is blocked/inactive
  | "auto_suspended_listing_inactive"          // SP-API listing state = INACTIVE/SUPPRESSED/NOT_FOUND
  | "auto_suspended_intl_stale"                // intl quantity data is stale (> 24h)
  | "auto_suspended_marketplace_not_sellable"  // marketplace_sellable=false (intl restriction)
  | "unknown_pending_verification"             // amazon_listing_state UNKNOWN, no clear reason
  | "activation_needs_cost"                    // inbound activation blocked: missing unit cost
  | "activation_price_unavailable"             // inbound activation blocked: no live Amazon price
  | "activation_bounds_unavailable"            // inbound activation blocked: bounds couldn't be computed
  | "auto_disabled"                            // legacy: disabled by cleanup / system w/ actor
  | "manually_paused"                          // user intentionally paused (the ONLY "Paused")
  | "needs_review";                            // disabled with no audit trail

export interface AssignmentStatusInput {
  is_enabled?: boolean | null;
  rule_id?: string | null;
  manual_paused?: boolean | null;
  last_disabled_by?: string | null;
  last_disabled_reason?: string | null;
  last_disabled_at?: string | null;

  // inventory match for this exact user+marketplace+asin+sku
  has_matching_inventory?: boolean | null;
  // hard inventory exhaustion (all zero AND not active)
  inventory_terminal?: boolean | null;

  // Phase 1 fact fields (all optional — render-only until writers populate them)
  amazon_listing_state?: string | null;        // ACTIVE | INACTIVE | SUPPRESSED | NOT_FOUND | UNKNOWN
  available?: number | null;
  reserved?: number | null;
  inbound?: number | null;
  inventory_confidence?: string | null;        // HIGH | MEDIUM | STALE | UNKNOWN
  intl_qty_confidence?: string | null;
  marketplace_sellable?: boolean | null;
  auto_suspended_reason?: string | null;       // NO_STOCK | INTL_STALE | LISTING_INACTIVE | INBOUND_ONLY_INACTIVE | MARKETPLACE_NOT_SELLABLE | LEGACY_UNAUDITED

  // Set by pricing-suppression-core when SP-API's summaries[].status drops
  // BUYABLE and keeps only DISCOVERABLE — exactly what Seller Central labels
  // "Inactive". The reason fields are populated from issues[] WHEN AMAZON
  // SENDS ONE; policy actions (counterfeit / IP complaints) carry no issues[]
  // entry at all, so null means "Amazon did not say", not "we did not look".
  is_listing_inactive_not_buyable?: boolean | null;
  listing_inactive_reason_code?: string | null;
  listing_inactive_reason_message?: string | null;

  status_legacy?: string | null;
  last_error_type?: string | null;
  consecutive_failures?: number | null;
}

export interface AssignmentStatus {
  kind: AssignmentStatusKind;
  label: string;
  tone: "active" | "info" | "warning" | "danger" | "muted";
  tooltip: string;
}

const MANUAL_ACTORS = new Set(["user", "manual", "seller", "owner"]);

function fmtInv(i: AssignmentStatusInput): string {
  const a = i.available ?? 0;
  const r = i.reserved ?? 0;
  const b = i.inbound ?? 0;
  return `available ${a} · reserved ${r} · inbound ${b}`;
}

export function deriveAssignmentStatus(i: AssignmentStatusInput): AssignmentStatus {
  // 1) Manual pause wins over everything. "Paused" label reserved for users.
  if (i.manual_paused === true) {
    return {
      kind: "manually_paused",
      label: "Paused",
      tone: "danger",
      tooltip: i.last_disabled_reason
        ? `Manually paused: ${i.last_disabled_reason}`
        : "Manually paused by you.",
    };
  }

  // 1b) Amazon has made the listing non-buyable. This is a FACT ABOUT THE
  // LISTING, not a decision of ours, so it outranks every derived reason
  // below — no rule, no stock and stale quantities are all irrelevant if
  // Amazon will not let anyone buy it.
  //
  // Placed after the manual-pause check only to preserve this file's stated
  // rule that "Paused" belongs exclusively to a deliberate seller action.
  //
  // Until now nothing rendered this flag. `auto_suspended_listing_inactive`
  // existed but keys off `auto_suspended_reason`, which no writer populates
  // for this case — so an assignment could be correctly detected as blocked,
  // correctly skipped by the dispatcher, and still show as "Active" on screen.
  // Observed 2026-08-25 on B0FTMPT33K, blocked by Amazon pending a counterfeit
  // appeal and flagged since 08-20.
  if (i.is_listing_inactive_not_buyable === true) {
    const reason = (i.listing_inactive_reason_message || "").trim();
    const code = (i.listing_inactive_reason_code || "").trim();
    return {
      kind: "blocked_not_buyable",
      label: "Blocked — not buyable on Amazon",
      tone: "danger",
      tooltip: reason
        ? `Amazon reports this listing is not buyable${code ? ` (${code})` : ""}: ${reason}`
        : // No issues[] entry came back. Say so plainly rather than inventing a
          // cause — policy actions such as authenticity or IP complaints are
          // visible only in Seller Central, never through the Listings API.
          "Amazon reports this listing is not buyable (status DISCOVERABLE without BUYABLE). " +
          "Amazon returned no reason via the API — check Seller Central under the listing's " +
          "\"Review blocked reason\" for the cause. Repricing is skipped while this holds.",
    };
  }

  // 2) No rule attached — never call this "paused\"
  if (!i.rule_id) {
    return {
      kind: "no_rule",
      label: "No rule assigned",
      tone: "info",
      tooltip: "Attach a repricer rule to start evaluating this listing.",
    };
  }

  // 3) Explicit auto-suspension reason wins (Phase 3 writers will populate this).
  switch ((i.auto_suspended_reason || "").toUpperCase()) {
    case "INBOUND_ONLY_INACTIVE":
      return {
        kind: "auto_suspended_inbound_only_inactive",
        label: "Suspended — Inbound only / listing inactive",
        tone: "warning",
        tooltip: `Inbound stock but Amazon listing is not ACTIVE. Waiting for activation. (${fmtInv(i)})`,
      };
    case "LISTING_INACTIVE":
      return {
        kind: "auto_suspended_listing_inactive",
        label: "Suspended — Listing inactive",
        tone: "warning",
        tooltip: `Amazon listing state: ${i.amazon_listing_state || "INACTIVE"}. Waiting for ACTIVE.`,
      };
    case "NO_STOCK":
      return {
        kind: "auto_suspended_no_stock",
        label: "Suspended — No stock",
        tone: "muted",
        tooltip: `No stock anywhere. (${fmtInv(i)})`,
      };
    case "INTL_STALE":
      return {
        kind: "auto_suspended_intl_stale",
        label: "Suspended — Intl quantity stale",
        tone: "warning",
        tooltip: "International quantity hasn't refreshed in over 24h. Awaiting next sync.",
      };
    case "MARKETPLACE_NOT_SELLABLE":
      return {
        kind: "auto_suspended_marketplace_not_sellable",
        label: "Suspended — Marketplace not sellable",
        tone: "warning",
        tooltip: "This marketplace is not currently sellable for this ASIN (restriction or approval required).",
      };
    case "LEGACY_UNAUDITED":
      return {
        kind: "needs_review",
        label: "Needs review — legacy disable",
        tone: "warning",
        tooltip: "Disabled before audit fields existed. Re-enable manually if intended.",
      };
  }

  // 4) Derive inbound-only-inactive when facts are present but writer hasn't tagged it yet.
  const listingState = (i.amazon_listing_state || "").toUpperCase();
  const available = i.available ?? 0;
  const inbound = i.inbound ?? 0;
  const reserved = i.reserved ?? 0;
  const haveInventoryFacts = i.available != null || i.reserved != null || i.inbound != null;

  if (haveInventoryFacts && available === 0 && inbound > 0 &&
      listingState && listingState !== "ACTIVE" && listingState !== "UNKNOWN") {
    return {
      kind: "auto_suspended_inbound_only_inactive",
      label: "Suspended — Inbound only / listing inactive",
      tone: "warning",
      tooltip: `Inbound stock but Amazon listing is ${listingState}. Waiting for activation. (${fmtInv(i)})`,
    };
  }

  // 5) Marketplace-not-sellable flag (intl)
  if (i.marketplace_sellable === false && !i.is_enabled) {
    return {
      kind: "auto_suspended_marketplace_not_sellable",
      label: "Suspended — Marketplace not sellable",
      tone: "warning",
      tooltip: "Restricted or approval required for this marketplace.",
    };
  }

  // 6) No matching inventory — TRUE terminal (zero across the board AND listing not active)
  if (i.has_matching_inventory === false || i.inventory_terminal === true) {
    // If there's inbound, this is NOT terminal — fall through to derived inbound logic above already.
    if (haveInventoryFacts && inbound > 0) {
      return {
        kind: "auto_suspended_inbound_only_inactive",
        label: "Suspended — Inbound only / awaiting verification",
        tone: "warning",
        tooltip: `Inbound stock present (${fmtInv(i)}). Verifying Amazon listing state.`,
      };
    }
    return {
      kind: "no_inventory",
      label: "No inventory",
      tone: "muted",
      tooltip: "No active inventory matches this user + marketplace + ASIN + SKU.",
    };
  }

  // 7) is_enabled=true → active path
  if (i.is_enabled) {
    return {
      kind: "active",
      label: "Active",
      tone: "active",
      tooltip: "Live — automatic evaluation active.",
    };
  }

  // 7b) Atomic-activation diagnostics from auto-assign-bulk — surface as their own
  // kinds so the user sees "Needs cost" / "Price unavailable" instead of generic
  // "Auto-disabled". Reason format: `activation_pending:<code>`.
  const reasonStr = (i.last_disabled_reason || "").toLowerCase();
  if (reasonStr.startsWith("activation_pending:")) {
    const code = reasonStr.split(":")[1] || "";
    if (code === "needs_cost") {
      return {
        kind: "activation_needs_cost",
        label: "Needs cost",
        tone: "warning",
        tooltip: "Inbound activation paused — add a unit cost in Product Library or Synced Inventory to activate.",
      };
    }
    if (code === "price_unavailable") {
      return {
        kind: "activation_price_unavailable",
        label: "Price unavailable",
        tone: "warning",
        tooltip: "Inbound activation paused — no live Amazon price yet. Will retry on next sync.",
      };
    }
    if (code === "no_default_rule") {
      return {
        kind: "no_rule",
        label: "No default rule",
        tone: "info",
        tooltip: "Mark a repricer rule as Default to let auto-activation attach it.",
      };
    }
    return {
      kind: "activation_bounds_unavailable",
      label: "Bounds unavailable",
      tone: "warning",
      tooltip: "Inbound activation paused — couldn't compute min/max from current data. Will retry.",
    };
  }

  // 8) Disabled with an audit actor but no Phase-3 reason yet
  const actor = (i.last_disabled_by || "").toLowerCase();
  if (MANUAL_ACTORS.has(actor)) {
    // Treat actor=user as manual pause only when manual_paused flag is also set; otherwise audit-only
    return {
      kind: "auto_disabled",
      label: "Auto-disabled",
      tone: "warning",
      tooltip: i.last_disabled_reason
        ? `Disabled by ${actor}: ${i.last_disabled_reason}`
        : `Disabled by ${actor}.`,
    };
  }
  if (actor) {
    return {
      kind: "auto_disabled",
      label: "Auto-disabled",
      tone: "warning",
      tooltip: i.last_disabled_reason
        ? `Disabled by ${actor}: ${i.last_disabled_reason}`
        : `Disabled by ${actor}.`,
    };
  }

  // 9) Listing state UNKNOWN: do NOT show "Pending verification" — fall through to needs_review.

  return {
    kind: "needs_review",
    label: "Needs review",
    tone: "warning",
    tooltip: "Disabled, but no audit record of who turned it off. Re-enable manually if intended.",
  };
}

/** True only when the seller manually paused. Use this in place of `!is_enabled`. */
export function isManuallyPaused(i: AssignmentStatusInput): boolean {
  return deriveAssignmentStatus(i).kind === "manually_paused";
}
