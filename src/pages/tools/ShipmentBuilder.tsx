import { Helmet } from "react-helmet-async";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileSpreadsheet,
  Layers3,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import {
  fetchShipmentLibrary,
  upsertShipmentLibraryRecord,
  deleteShipmentLibraryRecord,
  type ShipmentLibraryRow,
} from "@/lib/shipment-library-store";
import { CopyAsinButton } from "@/components/shipment/CopyAsinButton";
import AsinShipmentHistoryTab from "@/components/shipment/AsinShipmentHistoryTab";
import { PurchaseHistoryDialog } from "@/pages/tools/shipment-builder/PurchaseHistoryDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import BusinessModeBanner from "@/components/shipment/BusinessModeBanner";
import BusinessModePanels from "@/components/shipment/BusinessModePanels";
import { useBusinessMode } from "@/hooks/use-business-mode";

const ACTIVE_DRAFT_STORAGE_KEY = "shipment-builder-v1-active-draft";
const SHIPMENT_LIBRARY_STORAGE_KEY = "shipment-builder-v1-library";
const AMAZON_SELLER_CENTRAL_URL = "https://sellercentral.amazon.com/gp/ssof/shipping-queue.html/ref=xx_fbashipq_dnav_xx#fbashipment";
const AMAZON_SEND_TO_AMAZON_BASE_URL = "https://sellercentral.amazon.com/fba/sendtoamazon";
const buildSendToAmazonUrl = (inboundPlanId?: string | null) => {
  if (inboundPlanId && inboundPlanId.trim().length > 0) {
    // Deep link directly into the Send-to-Amazon workflow for this inbound plan.
    // Amazon uses the `pack_mixed_unit_step?wf=<inboundPlanId>` URL to resume an
    // unfinished inbound plan inside the Send to Amazon flow.
    return `${AMAZON_SEND_TO_AMAZON_BASE_URL}/pack_mixed_unit_step?wf=${encodeURIComponent(inboundPlanId)}`;
  }
  return AMAZON_SELLER_CENTRAL_URL;
};
const AMAZON_INBOUND_WRITE_ACCESS_CODE = "FBA_INB_0422";
const AMAZON_INBOUND_WRITE_ACCESS_BANNER =
  "Amazon shipment creation is currently unavailable for this account/app because FBA Inbound write access is not enabled.";
const AMAZON_INBOUND_WRITE_ACCESS_FALLBACK =
  "Shipment draft is ready. Amazon API write access is required to create the shipment automatically.";
const AMAZON_WORKFLOW_STEPS = [
  "createInboundPlan",
  "generatePackingOptions",
  "confirmPackingOption",
  "setPackingInformation",
] as const;
const AMAZON_PLAN_CONTINUED_STATUSES = new Set(["PROCESSING", "ACTIVE", "WORKING", "SHIPPED", "RECEIVING", "CLOSED"]);

const PREP_OPTIONS = [
  { value: "NO_PREP", label: "No prep needed" },
  { value: "POLYBAGGING", label: "Polybagging" },
  { value: "FRAGILE", label: "Fragile / glass" },
  { value: "LIQUID", label: "Liquid" },
  { value: "TEXTILE", label: "Textile / fabric" },
  { value: "SET", label: "Sold as set" },
  { value: "SHARP", label: "Sharp" },
  { value: "OTHER", label: "Other" },
] as const;

const STEPS = [
  { id: 1, title: "Create Shipment", short: "Shipment" },
  { id: 2, title: "Select Products", short: "Products" },
  { id: 3, title: "Quantities & Compliance", short: "Compliance" },
  { id: 4, title: "Box Setup", short: "Boxes" },
  { id: 5, title: "Dimensions & Weight", short: "Dimensions" },
  { id: 6, title: "Create Inbound Plan in Amazon", short: "Review" },
] as const;

type StepId = (typeof STEPS)[number]["id"];
type PrepValue = (typeof PREP_OPTIONS)[number]["value"];
type DimensionUnit = "in" | "cm";
type WeightUnit = "lb" | "kg";
type ShipmentCreationMode = "quantity-only" | "full-workflow";
type ShipmentStatus = "draft" | "continued" | "synced" | "completed" | "archived";
type WorkspaceSection = "new" | "drafts" | "continued" | "synced" | "archived" | "asin-history";

type InventoryRow = {
  id?: string;
  user_id?: string | null;
  asin: string | null;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  available: number | null;
  reserved?: number | null;
  inbound?: number | null;
  listing_status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  fba_blocked?: boolean | null;
  fba_block_reason?: string | null;
};

type CreatedListingSearchRow = {
  id?: string | null;
  user_id?: string | null;
  asin: string | null;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  fba_blocked?: boolean | null;
  fba_block_reason?: string | null;
};

type FnskuMapSearchRow = {
  id?: string | null;
  asin: string | null;
  seller_sku: string | null;
  updated_at?: string | null;
};

type LiveSellerListingSearchRow = {
  sku?: string | null;
  asin?: string | null;
  title?: string | null;
  status?: string | string[] | null;
};

type ShipmentItem = {
  id: string;
  sku: string;
  asin: string;
  title: string;
  imageUrl: string | null;
  availableQty: number;
  qtyToShip: number;
  prepCategory: PrepValue;
  expirationRequired: boolean;
  expirationDate: string;
  expirationManualOverride: boolean;
  expirationDetectionReason: string | null;
  /**
   * True once the user has explicitly added this item to the shipment
   * (typed a qty > 0 at least once, or chose it from search). Keeps the
   * row visible even if qty is later cleared to 0, so accidentally
   * blanking the input no longer removes the record. Use the per-row
   * delete button to remove it.
   */
  addedToShipment?: boolean;
  /**
   * True once the user has explicitly clicked "Save" on this row to confirm
   * the qty. Items with qty>0 but savedToShipment!==true are treated as
   * pending and will NOT be carried into later steps (Prep, Boxes, Plan).
   * Undefined is treated as unsaved so old drafts must be reconfirmed.
   */
  savedToShipment?: boolean;
  fbaBlocked?: boolean;
  fbaBlockReason?: string | null;
  /**
   * Brand-gating/approval status, checked against Amazon's live Listings
   * Restrictions API the moment the row is saved (see checkAsinGating) —
   * catches restricted-brand ASINs before they reach shipment-plan
   * submission, where Amazon would reject them.
   */
  gatingStatus?: "checking" | "approved" | "restricted" | "unknown";
  gatingReason?: string | null;
};

type LegacyDraftItem = Partial<ShipmentItem> & {
  image_url?: string | null;
  totalQtyToShip?: number;
  requiresExpirationDate?: boolean;
  expirationReason?: string | null;
};

type LegacyDraftShape = Partial<ShipmentDraftState> & {
  name?: string;
  items?: LegacyDraftItem[];
};

type BoxDimension = {
  length: number;
  width: number;
  height: number;
  unit: DimensionUnit;
};

type BoxWeight = {
  weight: number;
  unit: WeightUnit;
};

type MergeSource = {
  id: string;
  shipmentName: string;
  status: ShipmentStatus;
};

type ShipmentDraftState = {
  id: string;
  createdAt: string;
  step: StepId;
  creationMode: ShipmentCreationMode;
  status: ShipmentStatus;
  shipmentName: string;
  note: string;
  items: ShipmentItem[];
  numberOfBoxes: number;
  identicalBoxes: boolean;
  boxQuantities: Record<string, number[]>;
  applySameDimensions: boolean;
  sameDimensions: BoxDimension;
  boxDimensions: BoxDimension[];
  allowPerBoxWeight: boolean;
  sameWeight: BoxWeight;
  boxWeights: BoxWeight[];
  packedKeys: string[];
  inboundPlanId?: string;
  shipmentId?: string;
  shipmentIds?: string[];
  placementOptionId?: string;
  amazonShipmentCreatedAt?: string;
  mergedFrom?: MergeSource[];
  mergeCompatibility?: "preserved" | "rebuild-required";
  syncStatusNote?: string;
  amazonWriteAccessCode?: string;
  amazonWriteAccessMessage?: string;
  amazonWorkflowMessage?: string;
  amazonStepDiagnostics?: AmazonStepDiagnostic[];
  /** Operation handle returned by createInboundPlan. Used for polling. */
  amazonOperationId?: string;
  /**
   * Live SP-API plan status. Possible values:
   * - "PROCESSING": Amazon accepted the request (HTTP 202) but has not finished
   *   building the plan yet. UI must NOT show success.
   * - "ACTIVE" | "WORKING" | "SHIPPED" | "RECEIVING" | "CLOSED": usable.
   * - "ERRORED": Amazon rejected the plan after accepting it. UI shows failure.
   */
  amazonPlanStatus?: string;
  /** ISO timestamp of the most recent status check. */
  amazonPlanStatusCheckedAt?: string;
  archivedAt?: string;
  continuedToAmazonAt?: string;
  completedAt?: string;
  updatedAt: string;
};

type AmazonStepDiagnostic = {
  step: string;
  endpoint: string;
  success: boolean;
  status?: "success" | "failed" | "skipped";
  httpStatus?: number;
  code?: string;
  message: string;
  inboundPlanId?: string;
  operationId?: string;
  shipmentIds?: string[];
  details?: string;
  expirationContext?: AmazonExpirationContext | null;
};

type AmazonExpirationContext = {
  code?: string;
  message?: string;
  mentionedSkus?: string[];
  suspectedProducts?: Array<{ sku?: string; asin?: string; title?: string }>;
  missingExpirationProducts?: Array<{ sku?: string; asin?: string; title?: string }>;
  amazonMessage?: string;
};

type AmazonShipmentResult = {
  inboundPlanId: string;
  shipmentId: string | null;
  shipmentIds: string[];
  placementOptionId?: string;
  createdAt: string;
};

const getEdgeFunctionMessage = (
  error: { message?: string } | null | undefined,
  data: Record<string, unknown> | null | undefined,
  fallback: string,
) => {
  const genericEdgeError = /non-2xx|edge function|failed to fetch|networkerror|failed to create inbound plan|failed to create shipment in amazon/i;
  const detailParts = [
    typeof data?.error === "string" ? data.error : undefined,
    typeof data?.message === "string" ? data.message : undefined,
    typeof data?.details === "string" ? data.details : undefined,
    typeof data?.note === "string" ? data.note : undefined,
    Array.isArray(data?.nextSteps) ? (data.nextSteps as string[]).join(" ") : undefined,
    error?.message,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return detailParts.find((value) => !genericEdgeError.test(value)) ?? detailParts[0] ?? fallback;
};

const extractAmazonProblemMessages = (value: unknown): string[] => {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return extractAmazonProblemMessages(JSON.parse(value));
    } catch {
      return /operationProblems|errors|code|message|msku|sku|hazmat|prep|restricted/i.test(value) ? [value] : [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(extractAmazonProblemMessages);
  if (typeof value !== "object") return [];

  const item = value as Record<string, unknown>;
  const code = typeof item.code === "string" ? `[${item.code}] ` : "";
  const message = typeof item.message === "string" ? item.message : undefined;
  const details = typeof item.details === "string" ? ` (${item.details})` : "";
  const direct = message ? [`${code}${message}${details}`.trim()] : [];

  return [
    ...direct,
    ...extractAmazonProblemMessages(item.errors),
    ...extractAmazonProblemMessages(item.operationProblems),
    ...extractAmazonProblemMessages(item.problems),
  ];
};

const getEdgeFunctionDetailsText = (data: Record<string, unknown> | null | undefined) => {
  const details = data?.details;
  if (typeof details === "string") return details;
  if (Array.isArray(details)) {
    return details
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return JSON.stringify(item);
        return undefined;
      })
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" ");
  }
  return undefined;
};

const isExpirationRequiredMessage = (value: string) =>
  /expiration\s+(date\s+)?required|expiry\s+(date\s+)?required/i.test(value);

const extractExpirationContextFromPayload = (value: unknown): AmazonExpirationContext | null => {
  if (!value) return null;
  if (typeof value === "string") return isExpirationRequiredMessage(value) ? { amazonMessage: value } : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const context = extractExpirationContextFromPayload(item);
      if (context) return context;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  const item = value as Record<string, unknown>;
  if (item.expirationContext && typeof item.expirationContext === "object") {
    return item.expirationContext as AmazonExpirationContext;
  }
  return extractExpirationContextFromPayload([item.stepResults, item.operationProblems, item.errors, item.details, item.message, item.error]);
};

const getExpirationContextFromDraft = (draft: ShipmentDraftState) =>
  draft.amazonStepDiagnostics?.map((step) => step.expirationContext).find(Boolean) ??
  extractExpirationContextFromPayload(draft.amazonWorkflowMessage);

const getEdgeFunctionPayload = async (
  error: unknown,
  data: Record<string, unknown> | null | undefined,
) => {
  if (data) return data;

  const context =
    error && typeof error === "object" && "context" in error
      ? (error as { context?: Response }).context
      : undefined;

  if (!context || typeof context.clone !== "function") return undefined;

  try {
    return (await context.clone().json()) as Record<string, unknown>;
  } catch {
    try {
      const text = await context.clone().text();
      return text ? ({ details: text } as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
};

const getEdgeFunctionCode = (data: Record<string, unknown> | null | undefined) =>
  typeof data?.code === "string" ? data.code : undefined;

const createEmptyDimension = (): BoxDimension => ({ length: 0, width: 0, height: 0, unit: "in" });
const createEmptyWeight = (): BoxWeight => ({ weight: 0, unit: "lb" });
const INVENTORY_BATCH_SIZE = 1000;

const createDraftId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `shipment-${Date.now()}`;

const buildEmptyDraft = (): ShipmentDraftState => ({
  id: createDraftId(),
  createdAt: new Date().toISOString(),
  step: 1,
  creationMode: "quantity-only",
  status: "draft",
  shipmentName: "",
  note: "",
  items: [],
  numberOfBoxes: 1,
  identicalBoxes: true,
  boxQuantities: {},
  applySameDimensions: true,
  sameDimensions: createEmptyDimension(),
  boxDimensions: [createEmptyDimension()],
  allowPerBoxWeight: false,
  sameWeight: createEmptyWeight(),
  boxWeights: [createEmptyWeight()],
  packedKeys: [],
  inboundPlanId: undefined,
  shipmentId: undefined,
  shipmentIds: undefined,
  placementOptionId: undefined,
  amazonShipmentCreatedAt: undefined,
  amazonWriteAccessCode: undefined,
  amazonWriteAccessMessage: undefined,
  amazonWorkflowMessage: undefined,
  amazonStepDiagnostics: undefined,
  amazonOperationId: undefined,
  amazonPlanStatus: undefined,
  amazonPlanStatusCheckedAt: undefined,
  updatedAt: new Date().toISOString(),
});

const safeNumber = (value: string | number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeBoxArrays = (count: number, dimensions: BoxDimension[], weights: BoxWeight[]) => ({
  boxDimensions: Array.from({ length: count }, (_, index) => dimensions[index] ?? createEmptyDimension()),
  boxWeights: Array.from({ length: count }, (_, index) => weights[index] ?? createEmptyWeight()),
});

const cloneAllBoxDimensions = (count: number, dimension: BoxDimension) =>
  Array.from({ length: count }, () => ({ ...dimension }));

const cloneAllBoxWeights = (count: number, weight: BoxWeight) =>
  Array.from({ length: count }, () => ({ ...weight }));

const parseStoredDraft = (value: string | null): ShipmentDraftState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as LegacyDraftShape;
    if (!parsed.id) return null;
    const boxCount = Math.max(1, parsed.numberOfBoxes ?? 1);
    const normalized = normalizeBoxArrays(boxCount, parsed.boxDimensions ?? [], parsed.boxWeights ?? []);
    const legacyItems = (parsed.items ?? []) as LegacyDraftItem[];
    return {
      ...buildEmptyDraft(),
      ...parsed,
      createdAt: parsed.createdAt ?? parsed.updatedAt ?? new Date().toISOString(),
      step: Math.min(6, Math.max(1, parsed.step ?? 1)) as StepId,
      status: (parsed.status as ShipmentStatus | undefined) ?? ((parsed.shipmentId || parsed.inboundPlanId) ? "synced" : "draft"),
      shipmentName: parsed.shipmentName ?? parsed.name ?? "",
      note: parsed.note ?? "",
      items: legacyItems.map((item) => ({
        id: item.id ?? item.asin ?? item.sku ?? createDraftId(),
        sku: item.sku ?? "",
        asin: item.asin ?? "",
        title: item.title ?? "Untitled product",
        imageUrl: item.imageUrl ?? item.image_url ?? null,
        availableQty: item.availableQty ?? 0,
        qtyToShip: item.totalQtyToShip ?? item.qtyToShip ?? 0,
        addedToShipment: item.addedToShipment ?? (safeNumber(item.totalQtyToShip ?? item.qtyToShip ?? 0) > 0),
        // Preserve the user's per-row Save confirmation across reloads/step nav.
        // Missing/undefined is intentionally unsaved and must show the Save button.
        savedToShipment: item.savedToShipment,
        prepCategory: (item.prepCategory as PrepValue | undefined) ?? "NO_PREP",
        expirationRequired: item.expirationRequired ?? item.requiresExpirationDate ?? false,
        expirationDate: item.expirationDate ?? "",
        expirationManualOverride: item.expirationManualOverride ?? false,
        expirationDetectionReason: item.expirationDetectionReason ?? item.expirationReason ?? null,
      })),
      numberOfBoxes: boxCount,
      boxQuantities: parsed.boxQuantities ?? {},
      packedKeys: Array.isArray(parsed.packedKeys)
        ? parsed.packedKeys.filter((key): key is string => typeof key === "string")
        : [],
      sameDimensions: parsed.sameDimensions ?? createEmptyDimension(),
      boxDimensions: normalized.boxDimensions,
      sameWeight: parsed.sameWeight ?? createEmptyWeight(),
      boxWeights: normalized.boxWeights,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

const parseStoredLibrary = (value: string | null) => {
  if (!value) return [] as ShipmentDraftState[];

  try {
    const parsed = JSON.parse(value) as unknown[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => parseStoredDraft(JSON.stringify(entry)))
      .filter((entry): entry is ShipmentDraftState => Boolean(entry))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [] as ShipmentDraftState[];
  }
};

const shouldPersistDraftItem = (item: ShipmentItem) => {
  return (
    item.qtyToShip > 0 ||
    item.addedToShipment ||
    item.prepCategory !== "NO_PREP" ||
    item.expirationRequired ||
    Boolean(item.expirationDate) ||
    item.expirationManualOverride ||
    Boolean(item.expirationDetectionReason)
  );
};

const compactAmazonDiagnostics = (steps?: AmazonStepDiagnostic[]) => {
  if (!steps?.length) return undefined;

  return steps.map((step) => ({
    ...step,
    details: step.details ? step.details.slice(0, 500) : undefined,
  }));
};

const serializeDraftForStorage = (draft: ShipmentDraftState) => {
  const persistedItems = draft.items.filter(shouldPersistDraftItem);
  const persistedItemIds = new Set(persistedItems.map((item) => item.id));
  const persistedBoxQuantities = Object.fromEntries(
    Object.entries(draft.boxQuantities).filter(([itemId]) => persistedItemIds.has(itemId)),
  );

  return {
    ...draft,
    items: persistedItems,
    boxQuantities: persistedBoxQuantities,
    amazonStepDiagnostics: compactAmazonDiagnostics(draft.amazonStepDiagnostics),
  };
};

function normalizeAcceptedShipmentState(entry: ShipmentDraftState): ShipmentDraftState {
  if (entry.status === "synced" || entry.status === "completed" || entry.status === "archived") return entry;

  const planStatus = entry.amazonPlanStatus?.toUpperCase();
  const hasAcceptedPlan = Boolean(
    entry.inboundPlanId &&
    planStatus !== "ERRORED" &&
    (
      !planStatus ||
      AMAZON_PLAN_CONTINUED_STATUSES.has(planStatus) ||
      entry.amazonStepDiagnostics?.some((step) => step.step === "createInboundPlan" && (step.status === "success" || step.success))
    ),
  );

  if (!hasAcceptedPlan) return entry;

  const continuedAt = entry.continuedToAmazonAt ?? entry.amazonPlanStatusCheckedAt ?? entry.amazonShipmentCreatedAt ?? entry.updatedAt;
  return {
    ...entry,
    status: "continued",
    continuedToAmazonAt: continuedAt,
  };
}

const writeStorageSafely = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[ShipmentBuilder] Failed to persist ${key}:`, error);
    return false;
  }
};

const fetchShipmentBuilderInventory = async (userId: string) => {
  const allRows: InventoryRow[] = [];
  const seenIds = new Set<string>();
  let lastCreatedAt: string | null = null;
  let lastId: string | null = null;

  while (true) {
    let query = supabase
      .from("inventory")
      .select("id, asin, sku, title, image_url, available, reserved, inbound, listing_status, created_at, fba_blocked, fba_block_reason")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(INVENTORY_BATCH_SIZE);

    if (lastCreatedAt && lastId) {
      query = query.or(
        `created_at.lt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.lt.${lastId})`,
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const batch = ((data ?? []) as (InventoryRow & { created_at?: string | null; listing_status?: string | null })[]).filter((row) => {
      const rowId = row.id ?? `${row.asin}:${row.sku}`;
      if (seenIds.has(rowId)) return false;
      seenIds.add(rowId);

      // Filter out ghost / dead listings: terminal status with no stock and no inbound.
      const status = (row.listing_status ?? "").toUpperCase();
      const totalUnits =
        Number(row.available ?? 0) + Number(row.reserved ?? 0) + Number(row.inbound ?? 0);
      const isTerminal =
        status === "NOT_IN_CATALOG" ||
        status === "DELETED" ||
        status === "INACTIVE";
      if (isTerminal && totalUnits === 0) return false;

      return true;
    });

    if (batch.length === 0) break;

    allRows.push(...batch);

    const lastRow = batch[batch.length - 1];
    lastCreatedAt = lastRow.created_at ?? null;
    lastId = lastRow.id ?? null;

    if (batch.length < INVENTORY_BATCH_SIZE) break;
  }

  // Dedup by sku::asin — Amazon-style duplicates can produce one row with
  // image_url and another without. Prefer the row that actually has an image
  // (and richer stock numbers) so the shipment builder never shows an empty
  // image frame for a product that has imagery elsewhere in inventory.
  const dedupedByIdentity = new Map<string, InventoryRow>();
  for (const row of allRows) {
    const key = `${(row.sku ?? "").toUpperCase()}::${(row.asin ?? "").toUpperCase()}`;
    const existing = dedupedByIdentity.get(key);
    if (!existing) {
      dedupedByIdentity.set(key, row);
      continue;
    }
    const existingHasImg = !!(existing.image_url && String(existing.image_url).trim());
    const rowHasImg = !!(row.image_url && String(row.image_url).trim());
    if (rowHasImg && !existingHasImg) {
      dedupedByIdentity.set(key, { ...row, available: existing.available, reserved: existing.reserved, inbound: existing.inbound });
      continue;
    }
    if (!rowHasImg && existingHasImg) continue;
    const rowScore = Number(row.available ?? 0) + Number(row.reserved ?? 0) + Number(row.inbound ?? 0);
    const existingScore = Number(existing.available ?? 0) + Number(existing.reserved ?? 0) + Number(existing.inbound ?? 0);
    if (rowScore > existingScore) dedupedByIdentity.set(key, row);
  }

  return Array.from(dedupedByIdentity.values());
};

// In-memory + Supabase persistence. We no longer write the library to
// localStorage — every entry is upserted/removed in Supabase so counters
// survive across browsers, devices, refreshes, and cache clears.
const persistShipmentLibrary = (_library: ShipmentDraftState[]) => {
  // Intentionally a no-op. Supabase is the source of truth.
  // (Kept as a function so existing call sites still compile.)
};

const buildSupabaseRecordFromDraft = (entry: ShipmentDraftState) => {
  const normalizedEntry = normalizeAcceptedShipmentState(entry);
  const compact = serializeDraftForStorage(normalizedEntry);
  const status = normalizedEntry.status as ShipmentStatus;
  return {
    draftId: normalizedEntry.id,
    shipmentName: normalizedEntry.shipmentName ?? "",
    note: normalizedEntry.note ?? "",
    status,
    step: normalizedEntry.step ?? 1,
    creationMode: normalizedEntry.creationMode ?? "quantity-only",
    payload: compact as unknown as Record<string, unknown>,
    inboundPlanId: normalizedEntry.inboundPlanId ?? null,
    amazonShipmentId: normalizedEntry.shipmentId ?? null,
    placementOptionId: normalizedEntry.placementOptionId ?? null,
    continuedToAmazonAt: normalizedEntry.continuedToAmazonAt ?? null,
    syncedAt: status === "synced" || status === "completed"
      ? normalizedEntry.amazonShipmentCreatedAt ?? normalizedEntry.updatedAt
      : null,
    completedAt: status === "completed" ? normalizedEntry.completedAt ?? normalizedEntry.updatedAt : null,
    archivedAt: normalizedEntry.archivedAt ?? null,
    amazonOperationId: normalizedEntry.amazonOperationId ?? null,
    amazonPlanStatus: normalizedEntry.amazonPlanStatus ?? null,
  };
};

const persistEntryToSupabase = (userId: string | undefined, entry: ShipmentDraftState) => {
  if (!userId) return;
  void upsertShipmentLibraryRecord(userId, buildSupabaseRecordFromDraft(entry));
};

const deleteEntryFromSupabase = (userId: string | undefined, draftId: string) => {
  if (!userId) return;
  void deleteShipmentLibraryRecord(userId, draftId);
};

const upsertShipmentRecord = (
  library: ShipmentDraftState[],
  nextDraft: ShipmentDraftState,
  userId?: string,
) => {
  const normalizedDraft = normalizeAcceptedShipmentState(nextDraft);
  const next = [normalizedDraft, ...library.filter((entry) => entry.id !== normalizedDraft.id)]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 200);
  persistEntryToSupabase(userId, normalizedDraft);
  return next;
};

const removeShipmentRecord = (
  library: ShipmentDraftState[],
  draftId: string,
  userId?: string,
) => {
  const next = library.filter((entry) => entry.id !== draftId);
  deleteEntryFromSupabase(userId, draftId);
  return next;
};

const getSkuIdentity = (item: Pick<ShipmentItem, "sku" | "asin">) =>
  `${(item.sku ?? "").trim().toUpperCase()}::${(item.asin ?? "").trim().toUpperCase()}`;

const isGeneratedAmazonImageFallback = (url: string | null | undefined) =>
  typeof url === "string" && /\/images\/P\/[A-Z0-9]{10}\.01\._/i.test(url);

const preferHydratedImage = (existingUrl: string | null | undefined, incomingUrl: string | null | undefined) => {
  const existing = typeof existingUrl === "string" && existingUrl.trim() ? existingUrl : null;
  const incoming = typeof incomingUrl === "string" && incomingUrl.trim() ? incomingUrl : null;
  if (!existing) return incoming;
  if (!incoming) return existing;
  return isGeneratedAmazonImageFallback(existing) && !isGeneratedAmazonImageFallback(incoming) ? incoming : existing;
};

const mapInventoryRowToShipmentItem = (row: InventoryRow): ShipmentItem => ({
  // Use the canonical sku::asin identity as the React key so that any rows that
  // dedup collapses cannot reappear as separate UI rows with colliding ids
  // (which previously caused qty edits to fan out across "duplicates").
  id: `${(row.sku ?? "").trim().toUpperCase()}::${(row.asin ?? "").trim().toUpperCase()}`,
  sku: row.sku ?? "",
  asin: row.asin ?? "",
  title: row.title || row.sku || row.asin || "Untitled product",
  imageUrl: (row.image_url && String(row.image_url).trim())
    ? row.image_url
    : (row.asin ? `https://images.amazon.com/images/P/${row.asin}.01._SL75_.jpg` : null),
  availableQty: Math.max(0, safeNumber(row.available ?? 0)),
  qtyToShip: 0,
  prepCategory: "NO_PREP",
  expirationRequired: false,
  expirationDate: "",
  expirationManualOverride: false,
  expirationDetectionReason: null,
  fbaBlocked: row.fba_blocked === true,
  fbaBlockReason: row.fba_block_reason ?? null,
});

const mapCreatedListingRowToInventoryRow = (row: CreatedListingSearchRow): InventoryRow => ({
  id: row.id ?? `created:${row.sku ?? ""}:${row.asin ?? ""}`,
  user_id: row.user_id ?? null,
  asin: row.asin,
  sku: row.sku,
  title: row.title,
  image_url: row.image_url,
  available: 0,
  reserved: 0,
  inbound: 0,
  listing_status: null,
  created_at: row.created_at ?? null,
  updated_at: row.updated_at ?? null,
  fba_blocked: row.fba_blocked ?? false,
  fba_block_reason: row.fba_block_reason ?? null,
});

const mapFnskuRowToInventoryRow = (row: FnskuMapSearchRow): InventoryRow => ({
  id: row.id ?? `fnsku:${row.seller_sku ?? ""}:${row.asin ?? ""}`,
  asin: row.asin,
  sku: row.seller_sku,
  title: row.seller_sku || row.asin || "Untitled product",
  image_url: null,
  available: 0,
  reserved: 0,
  inbound: 0,
  listing_status: null,
  updated_at: row.updated_at ?? null,
});

const mapLiveSellerListingToInventoryRow = (row: LiveSellerListingSearchRow, asin: string): InventoryRow => ({
  id: `live:${row.sku ?? ""}:${row.asin ?? asin}`,
  asin: row.asin ?? asin,
  sku: row.sku ?? null,
  title: row.title ?? row.sku ?? row.asin ?? asin,
  image_url: null,
  available: 0,
  reserved: 0,
  inbound: 0,
  listing_status: Array.isArray(row.status) ? row.status.join(",") : row.status ?? "LIVE_AMAZON",
  updated_at: null,
});

const hydrateDraftItems = (inventoryItems: ShipmentItem[], draftItems: ShipmentItem[]) => {
  const draftByKey = new Map(draftItems.map((item) => [getSkuIdentity(item), item]));
  const mergedInventory = inventoryItems.map((item) => {
    const existing = draftByKey.get(getSkuIdentity(item));
    return existing
      ? {
          ...item,
          ...existing,
          imageUrl: preferHydratedImage(existing.imageUrl, item.imageUrl),
          title: existing.title || item.title,
          availableQty: item.availableQty,
        }
      : item;
  });

  const extras = draftItems.filter((item) => !mergedInventory.some((inventoryItem) => getSkuIdentity(inventoryItem) === getSkuIdentity(item)));
  return [...mergedInventory, ...extras];
};

const getSelectedDraftItems = (draft: ShipmentDraftState) => draft.items.filter((item) => item.qtyToShip > 0);

const getShipmentStatusLabel = (status: ShipmentStatus) => {
  switch (status) {
    case "draft":
      return "Draft";
    case "continued":
      return "Continued to Amazon";
    case "synced":
      return "Synced";
    case "completed":
      return "Completed";
    case "archived":
      return "Archived";
    default:
      return status;
  }
};

const getStatusBadgeVariant = (status: ShipmentStatus): "default" | "secondary" | "outline" => {
  switch (status) {
    case "synced":
    case "completed":
      return "default";
    case "continued":
      return "default";
    case "archived":
      return "outline";
    default:
      return "secondary";
  }
};

const arraysEqual = (left: number[], right: number[]) => JSON.stringify(left) === JSON.stringify(right);

const buildMergedShipmentName = (drafts: ShipmentDraftState[]) =>
  drafts
    .map((entry) => entry.shipmentName?.trim() || "Untitled")
    .join(" + ");

const getMergedCreationMode = (drafts: ShipmentDraftState[]): ShipmentCreationMode => {
  const [firstDraft] = drafts;
  if (!firstDraft) return "quantity-only";

  return drafts.every((entry) => entry.creationMode === firstDraft.creationMode)
    ? firstDraft.creationMode
    : "full-workflow";
};

const mergeDraftsIntoShipment = (drafts: ShipmentDraftState[], shipmentName?: string): ShipmentDraftState => {
  const mergedAt = new Date().toISOString();
  const itemMap = new Map<string, ShipmentItem>();

  drafts.forEach((draft) => {
    draft.items.forEach((item) => {
      const key = getSkuIdentity(item);
      const existing = itemMap.get(key);
      if (existing) {
        itemMap.set(key, {
          ...existing,
          qtyToShip: existing.qtyToShip + item.qtyToShip,
          availableQty: Math.max(existing.availableQty, item.availableQty),
          expirationRequired: existing.expirationRequired || item.expirationRequired,
          expirationDate: existing.expirationDate || item.expirationDate,
          expirationManualOverride: existing.expirationManualOverride || item.expirationManualOverride,
        });
        return;
      }

      itemMap.set(key, {
        ...item,
        id: getSkuIdentity(item),
      });
    });
  });

  const baseDraft = buildEmptyDraft();
  return {
    ...baseDraft,
    id: createDraftId(),
    createdAt: mergedAt,
    step: 1,
    shipmentName: shipmentName?.trim() || buildMergedShipmentName(drafts),
    note: "Merged from existing drafts. Products and quantities were combined by SKU. Box setup needs to be rebuilt.",
    creationMode: getMergedCreationMode(drafts),
    status: "draft",
    items: Array.from(itemMap.values()),
    numberOfBoxes: 1,
    identicalBoxes: true,
    boxQuantities: {},
    applySameDimensions: true,
    sameDimensions: createEmptyDimension(),
    boxDimensions: [createEmptyDimension()],
    allowPerBoxWeight: false,
    sameWeight: createEmptyWeight(),
    boxWeights: [createEmptyWeight()],
    mergedFrom: drafts.map((entry) => ({ id: entry.id, shipmentName: entry.shipmentName || "Untitled shipment", status: entry.status })),
    mergeCompatibility: "rebuild-required",
    updatedAt: mergedAt,
  };
};

type DraftSortOption = "updated-desc" | "updated-asc" | "name-asc" | "name-desc" | "created-desc" | "created-asc";

const exportRowsFromDraft = (draft: ShipmentDraftState) => {
  const dimensionsPerBox = draft.applySameDimensions ? [] : draft.boxDimensions;
  const weightsPerBox = draft.allowPerBoxWeight ? draft.boxWeights : [];

  return Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => {
    const dimension = draft.applySameDimensions ? draft.sameDimensions : dimensionsPerBox[boxIndex];
    const weight = draft.allowPerBoxWeight ? weightsPerBox[boxIndex] : draft.sameWeight;

    return draft.items.flatMap((item) => {
      const quantity = draft.identicalBoxes
        ? draft.boxQuantities[item.id]?.[0] ?? 0
        : draft.boxQuantities[item.id]?.[boxIndex] ?? 0;

      if (quantity <= 0) return [];

      return {
        SKU: item.sku,
        "Box #": boxIndex + 1,
        Quantity: quantity,
        Length: dimension.length,
        Width: dimension.width,
        Height: dimension.height,
        Weight: weight.weight,
      };
    });
  }).flat();
};

const buildCopySummary = (draft: ShipmentDraftState) => {
  const lines = [
    `${draft.shipmentName}`,
    draft.note ? draft.note : null,
    "",
    ...draft.items.map((item) => `${item.sku} — ${item.qtyToShip} units`),
    "",
    `Total Boxes: ${draft.numberOfBoxes}`,
    `Total Units: ${draft.items.reduce((sum, item) => sum + item.qtyToShip, 0)}`,
  ].filter(Boolean);

  return lines.join("\n");
};

const buildAmazonDebugDetails = (draft: ShipmentDraftState) => {
  const diagnostics = draft.amazonStepDiagnostics ?? [];
  const lines = [
    `Shipment: ${draft.shipmentName || "Untitled shipment"}`,
    `Inbound Plan ID: ${draft.inboundPlanId ?? "n/a"}`,
    `Shipment ID: ${draft.shipmentId ?? "n/a"}`,
    `Write Access Message: ${draft.amazonWriteAccessMessage ?? "n/a"}`,
    `Workflow Message: ${draft.amazonWorkflowMessage ?? "n/a"}`,
    `Sync Status Note: ${draft.syncStatusNote ?? "n/a"}`,
    "",
    "Amazon Step Diagnostics",
  ];

  diagnostics.forEach((step, index) => {
    lines.push(
      `${index + 1}. ${step.step}`,
      `   status: ${step.status ?? (step.success ? "success" : "failed")}`,
      `   endpoint: ${step.endpoint}`,
      `   httpStatus: ${typeof step.httpStatus === "number" ? step.httpStatus : "n/a"}`,
      `   amazonCode: ${step.code ?? "n/a"}`,
      `   message: ${step.message}`,
      `   inboundPlanId: ${step.inboundPlanId ?? "n/a"}`,
      `   operationId: ${step.operationId ?? "n/a"}`,
      `   shipmentIds: ${step.shipmentIds?.join(", ") ?? "n/a"}`,
      `   details: ${step.details ?? "n/a"}`,
      "",
    );
  });

  return lines.join("\n");
};

const normalizeAmazonDiagnostics = (steps: AmazonStepDiagnostic[]) => {
  const normalized = steps.map((step) => ({
    ...step,
    status: step.status ?? (step.success ? "success" : "failed"),
  }));

  AMAZON_WORKFLOW_STEPS.forEach((workflowStep) => {
    if (!normalized.some((step) => step.step === workflowStep)) {
      normalized.push({
        step: workflowStep,
        endpoint: "Not called in current workflow",
        success: false,
        status: "skipped",
        message: `${workflowStep} was not called in the current Amazon workflow run.`,
      });
    }
  });

  return normalized.sort(
    (left, right) => AMAZON_WORKFLOW_STEPS.indexOf(left.step as (typeof AMAZON_WORKFLOW_STEPS)[number]) - AMAZON_WORKFLOW_STEPS.indexOf(right.step as (typeof AMAZON_WORKFLOW_STEPS)[number]),
  );
};

const getAmazonProgressSummary = (draft: ShipmentDraftState) => {
  const diagnostics = draft.amazonStepDiagnostics ?? [];
  const hasSuccess = (stepName: string) =>
    diagnostics.some((step) => step.step === stepName && (step.status === "success" || step.success));
  const hasSkippedPackingAsUnsupported = diagnostics.some(
    (step) =>
      step.step === "generatePackingOptions" &&
      step.status === "skipped" &&
      (step.code === "PACKING_OPTIONS_NOT_SUPPORTED" || /does not support packing options/i.test(step.message)),
  );

  return [
    {
      label: "Initial plan created",
      state: hasSuccess("createInboundPlan") ? "done" : "pending",
    },
    {
      label: "Packing submitted",
      state: hasSkippedPackingAsUnsupported || hasSuccess("generatePackingOptions") || hasSuccess("confirmPackingOption") || hasSuccess("setPackingInformation") ? "done" : "pending",
    },
    {
      label: "Placement not completed",
      state: hasSuccess("confirmPlacementOption") ? "done" : "current",
    },
    {
      label: "Transportation not completed",
      state: "pending",
    },
  ] as const;
};

export default function ShipmentBuilder() {
  const { user } = useAuth();
  const [draft, setDraft] = useState<ShipmentDraftState>(() => buildEmptyDraft());
  const [amazonStatusModalOpen, setAmazonStatusModalOpen] = useState(false);
  const lastAmazonStatusKeyRef = useRef<string>("");
  const [shipmentLibrary, setShipmentLibrary] = useState<ShipmentDraftState[]>([]);
  const [inventory, setInventory] = useState<ShipmentItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryLoaded, setInventoryLoaded] = useState(true);
  const [search, setSearch] = useState("");
  // The committed search query — only updated when the user presses Enter or
  // clicks the Search button. The inventory search effect listens to this,
  // not to the raw input, so typing alone never fires a query.
  // Restore the last committed search + results from sessionStorage so that
  // leaving Step 2 and coming back shows the exact same list without re-running
  // the query (no "Searching inventory…" flash on remount).
  const SEARCH_CACHE_KEY = `shipment-builder:search:${user?.id ?? "anon"}`;
  const readSearchCache = (): { query: string; results: ShipmentItem[] } | null => {
    try {
      const raw = sessionStorage.getItem(SEARCH_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.query === "string" && Array.isArray(parsed?.results)) {
        return { query: parsed.query, results: parsed.results as ShipmentItem[] };
      }
    } catch {}
    return null;
  };
  const initialSearchCache = readSearchCache();
  const [searchQuery, setSearchQuery] = useState(initialSearchCache?.query ?? "");
  const [searchResults, setSearchResults] = useState<ShipmentItem[]>(initialSearchCache?.results ?? []);
  const [searchLoading, setSearchLoading] = useState(false);
  // Tracks the query whose results are currently cached in `searchResults`, so
  // the fetch effect can skip re-running when the same query is restored.
  const lastFetchedQueryRef = useRef<string>(initialSearchCache?.query.trim() ?? "");
  // Seed `search` input with the restored query on first mount only.
  useEffect(() => {
    if (initialSearchCache?.query && !search) {
      setSearch(initialSearchCache.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist committed query + results whenever they change.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        SEARCH_CACHE_KEY,
        JSON.stringify({ query: searchQuery, results: searchResults }),
      );
    } catch {}
  }, [SEARCH_CACHE_KEY, searchQuery, searchResults]);
  const [asinSyncOpen, setAsinSyncOpen] = useState(false);
  const [purchaseHistoryAsin, setPurchaseHistoryAsin] = useState<{ asin: string; units: number } | null>(null);
  const [asinSyncValue, setAsinSyncValue] = useState("");
  const [asinSyncSku, setAsinSyncSku] = useState("");
  const [asinSyncBusy, setAsinSyncBusy] = useState(false);
  const [asinSyncResult, setAsinSyncResult] = useState<
    | { ok: true; asin: string; sku: string; title: string; imageUrl: string | null; available: number }
    | { ok: false; message: string }
    | null
  >(null);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [expirationDetectionLoading, setExpirationDetectionLoading] = useState(false);
  const [selectedComplianceItemIds, setSelectedComplianceItemIds] = useState<string[]>([]);
  const [flaggedExpirationItemIds, setFlaggedExpirationItemIds] = useState<string[]>([]);
  const handledExpirationSignatureRef = useRef<string | null>(null);
  const [shipmentSubmitting, setShipmentSubmitting] = useState(false);
  const [checkPlanStatusBusy, setCheckPlanStatusBusy] = useState(false);
  const [planStatusDialog, setPlanStatusDialog] = useState<{
    open: boolean;
    inboundPlanId: string;
    status: string;
    shipmentIds: string[];
    shipmentsCount: number;
    destinationMarketplaces: unknown[];
    sourceAddress: unknown;
    fetchedAt: string;
    error?: string;
    httpStatus?: number;
    operationErrors?: Array<{ operation: string; status: string; messages: string[] }>;
  } | null>(null);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>("drafts");
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [focusedShipmentId, setFocusedShipmentId] = useState<string | null>(null);
  const [draftSort, setDraftSort] = useState<DraftSortOption>("created-desc");
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeName, setMergeName] = useState("");
  const [renameDialogEntry, setRenameDialogEntry] = useState<ShipmentDraftState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  // ASIN -> unit cost (Contract A: amount is unit cost; else cost/units)
  const [costByAsin, setCostByAsin] = useState<Record<string, number>>({});
  // Step 6 packing confirmation is stored on the draft so it follows the user across devices.
  const packedKeys = useMemo(() => new Set(draft.packedKeys ?? []), [draft.packedKeys]);
  const [highlightedPackKey, setHighlightedPackKey] = useState<string | null>(null);
  const packRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Review & Pack popup mirrors the Step 6 list and edits the same underlying state
  const [reviewPackOpen, setReviewPackOpen] = useState(false);
  const dialogPackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const productTableScrollRef = useRef<HTMLDivElement | null>(null);
  const activeDraftRef = useRef(draft);
  const lastLocalDraftChangeAtRef = useRef(0);
  const remoteHydrationRef = useRef(false);
  const [cloudLoadComplete, setCloudLoadComplete] = useState(false);
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);
  const [lastLibraryRefreshAt, setLastLibraryRefreshAt] = useState<string | null>(null);

  useEffect(() => {
    activeDraftRef.current = draft;
  }, [draft]);

  // Convert a Supabase row back into the in-memory draft shape.
  const rowToDraft = useCallback((row: ShipmentLibraryRow): ShipmentDraftState | null => {
    const payloadString = JSON.stringify(row.payload ?? {});
    const parsed = parseStoredDraft(payloadString);
    if (!parsed) return null;
    return normalizeAcceptedShipmentState({
      ...parsed,
      id: row.draft_id,
      shipmentName: row.shipment_name || parsed.shipmentName,
      note: row.note || parsed.note,
      status: (row.status as ShipmentStatus) || parsed.status,
      step: (row.step as StepId) || parsed.step,
      creationMode: (row.creation_mode as ShipmentCreationMode) || parsed.creationMode,
      inboundPlanId: row.inbound_plan_id ?? parsed.inboundPlanId,
      shipmentId: row.amazon_shipment_id ?? parsed.shipmentId,
      placementOptionId: row.placement_option_id ?? parsed.placementOptionId,
      continuedToAmazonAt: row.continued_to_amazon_at ?? parsed.continuedToAmazonAt,
      completedAt: row.completed_at ?? parsed.completedAt,
      archivedAt: row.archived_at ?? parsed.archivedAt,
      amazonOperationId: row.amazon_operation_id ?? parsed.amazonOperationId,
      amazonPlanStatus: row.amazon_plan_status ?? parsed.amazonPlanStatus,
      updatedAt: row.updated_at ?? parsed.updatedAt,
    });
  }, []);

  const refreshShipmentLibraryFromCloud = useCallback(async (options: { silent?: boolean; hydrateActive?: boolean } = {}) => {
    if (!user) return;
    if (!options.silent) setLibraryRefreshing(true);
    try {
      const rows = await fetchShipmentLibrary(user.id);
      const libraryFromSupabase = rows
        .map(rowToDraft)
        .filter((entry): entry is ShipmentDraftState => Boolean(entry))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      setShipmentLibrary(libraryFromSupabase);
      setLastLibraryRefreshAt(new Date().toISOString());
      setCloudLoadComplete(true);

      if (options.hydrateActive) {
        const currentDraft = activeDraftRef.current;
        const remoteDraft = libraryFromSupabase.find((entry) => entry.id === currentDraft.id);
        const remoteIsNewer = remoteDraft && new Date(remoteDraft.updatedAt).getTime() > new Date(currentDraft.updatedAt).getTime();
        const localEditIsRecent = Date.now() - lastLocalDraftChangeAtRef.current < 5000;
        if (remoteDraft && remoteIsNewer && !localEditIsRecent) {
          const hydrated = {
            ...remoteDraft,
            items: hydrateDraftItems(inventory, remoteDraft.items),
          };
          remoteHydrationRef.current = true;
          setDraft(hydrated);
          setAutosaveReady(true);
          setRestoredDraft(true);
          setFocusedShipmentId(hydrated.id);
          writeStorageSafely(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify(serializeDraftForStorage(hydrated)));
        }
      }

      if (!options.silent) toast.success("Shipment library refreshed");
    } catch (err) {
      console.warn("[ShipmentBuilder] library refresh failed:", err);
      setCloudLoadComplete(true);
      if (!options.silent) toast.error("Could not refresh shipments from cloud");
    } finally {
      if (!options.silent) setLibraryRefreshing(false);
    }
  }, [inventory, rowToDraft, user]);

  // Initial load: restore active draft from localStorage (snappy editor),
  // and load the library from Supabase. One-time migration pushes any
  // legacy localStorage library entries up to Supabase, then clears them.
  useEffect(() => {
    // Restore the in-progress active draft from localStorage so that leaving
    // and returning to the page keeps the user exactly where they were — no
    // re-loading, no losing typed quantities. Users can still pick a
    // different shipment from the Drafts table.
    try {
      const stored = localStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);
      const restored = parseStoredDraft(stored);
      if (restored && restored.items && restored.items.length > 0) {
        setDraft(restored);
        setAutosaveReady(true);
        setRestoredDraft(true);
        setFocusedShipmentId(restored.id);
        setWorkspaceSection("new");
      }
    } catch {
      // ignore storage errors
    }

    if (!user) return;

    let cancelled = false;
    (async () => {
      // 1) Migrate legacy localStorage library entries (one-time).
      const legacyRaw = localStorage.getItem(SHIPMENT_LIBRARY_STORAGE_KEY);
      const legacyEntries = parseStoredLibrary(legacyRaw);
      if (legacyEntries.length > 0) {
        try {
          await Promise.all(
            legacyEntries.map((entry) =>
              upsertShipmentLibraryRecord(user.id, buildSupabaseRecordFromDraft(entry)),
            ),
          );
          localStorage.removeItem(SHIPMENT_LIBRARY_STORAGE_KEY);
          toast.success(`${legacyEntries.length} shipment(s) migrated to your account`);
        } catch (err) {
          console.warn("[ShipmentBuilder] migration failed:", err);
        }
      }

      // 2) Fetch the canonical library from Supabase.
      await refreshShipmentLibraryFromCloud({ silent: true, hydrateActive: false });
      if (cancelled) return;
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshShipmentLibraryFromCloud, user]);

  // Inventory is no longer preloaded in full. Listings are fetched on demand
  // via the Search input below to keep draft opening fast.
  useEffect(() => {
    setInventoryLoading(false);
    setInventoryLoaded(true);
  }, [refreshShipmentLibraryFromCloud, user]);

  // Keep the shipment workspace synced across computers. Manual edits are
  // protected for a few seconds so another tab/device cannot overwrite typing.
  useEffect(() => {
    if (!user) return;
    const syncFromCloud = () => {
      void refreshShipmentLibraryFromCloud({ silent: true, hydrateActive: true });
    };
    window.addEventListener("focus", syncFromCloud);
    const intervalId = window.setInterval(syncFromCloud, 15000);
    return () => {
      window.removeEventListener("focus", syncFromCloud);
      window.clearInterval(intervalId);
    };
  }, [user]);

  useEffect(() => {
    const checkAdmin = async () => {
      if (!user) {
        setIsAdmin(false);
        return;
      }

      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      setIsAdmin(!!data);
    };

    void checkAdmin();
  }, [user]);

  // When new search results stream in, merge them into the draft so users can
  // edit Qty to Ship without losing previously selected items.
  useEffect(() => {
    if (searchResults.length === 0) return;
    setDraft((current) => ({
      ...current,
      items: hydrateDraftItems(searchResults, current.items),
    }));
  }, [searchResults]);

  // Active editor: write to localStorage instantly (snappy), and debounce
  // the Supabase write so we don't spam on every keystroke.
  useEffect(() => {
    if (!autosaveReady) return;
    if (user && !cloudLoadComplete) return;
    if (remoteHydrationRef.current) {
      remoteHydrationRef.current = false;
      return;
    }
    lastLocalDraftChangeAtRef.current = Date.now();
    const nextDraft = normalizeAcceptedShipmentState({ ...draft, updatedAt: new Date().toISOString() });
    activeDraftRef.current = nextDraft;
    const payload = JSON.stringify(serializeDraftForStorage(nextDraft));
    writeStorageSafely(ACTIVE_DRAFT_STORAGE_KEY, payload);

    // In-memory library: keep it instant for the UI.
    setShipmentLibrary((current) =>
      [nextDraft, ...current.filter((entry) => entry.id !== nextDraft.id)]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 200),
    );

    // Debounced Supabase upsert.
    if (!user) return;
    const handle = setTimeout(() => {
      persistEntryToSupabase(user.id, nextDraft);
    }, 1500);
    return () => clearTimeout(handle);
  }, [cloudLoadComplete, draft, autosaveReady, user]);

  // Search inventory only when the user submits (Enter key or Search button).
  // Typing alone never fires a query — the effect listens to `searchQuery`,
  // which is committed via `setSearchQuery(search)`.
  useEffect(() => {
    if (!user) return;
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchLoading(false);
      return;
    }

    // Skip re-fetching if this exact query is already the one whose results
    // we're showing (e.g. restored from sessionStorage on remount).
    if (lastFetchedQueryRef.current === query && searchResults.length > 0) {
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    // Clear previous results so the old list isn't shown while the new query runs.
    setSearchResults([]);

    const handle = setTimeout(async () => {
      try {
        const escaped = query.replace(/[%,]/g, " ").trim();
        const pattern = `%${escaped}%`;
        const baseSelect = "id, user_id, asin, sku, title, image_url, available, reserved, inbound, listing_status, fba_blocked, fba_block_reason";
        const { data, error } = await supabase
          .from("inventory")
          .select(baseSelect)
          .eq("user_id", user.id)
          .or(`sku.ilike.${pattern},asin.ilike.${pattern},title.ilike.${pattern}`)
          .order("created_at", { ascending: false, nullsFirst: false })
          .limit(50);

        if (cancelled) return;
        if (error) throw error;

        let rows: InventoryRow[] = (data ?? []) as InventoryRow[];
        let usedAdminInventorySearch = false;
        if (rows.length === 0) {
          const { data: adminRole } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .eq("role", "admin")
            .maybeSingle();

          if (adminRole) {
            const { data: adminRows, error: adminError } = await supabase
              .from("inventory")
              .select(baseSelect)
              .or(`sku.ilike.${pattern},asin.ilike.${pattern},title.ilike.${pattern}`)
              .order("created_at", { ascending: false, nullsFirst: false })
              .limit(50);

            if (cancelled) return;
            if (adminError) throw adminError;
            rows = (adminRows ?? []) as InventoryRow[];
            usedAdminInventorySearch = true;
          }
        }

        const [createdListingResult, sellerAuthResult] = await Promise.all([
          // Match created_listings by SKU/ASIN/title so missing inventory images
          // can be hydrated from Product Library history. Ghost SKU expansion is
          // still blocked below by tombstone filtering and SKU::ASIN dedupe.
          supabase
            .from("created_listings")
            .select("id, user_id, asin, sku, title, image_url, updated_at, created_at, fba_blocked, fba_block_reason")
            .eq("user_id", user.id)
            .or(`sku.ilike.${pattern},asin.ilike.${pattern},title.ilike.${pattern}`)
            .order("created_at", { ascending: false, nullsFirst: false })
            .limit(50),
          supabase
            .from("seller_authorizations")
            .select("seller_id, marketplace_id")
            .eq("user_id", user.id),
        ]);

        if (cancelled) return;
        if (createdListingResult.error) {
          console.warn("[ShipmentBuilder] Created listings search failed:", createdListingResult.error);
        } else {
          rows.push(...((createdListingResult.data ?? []) as unknown as CreatedListingSearchRow[]).map(mapCreatedListingRowToInventoryRow));
        }

        const sellerAuth = (sellerAuthResult.data ?? []).find((row) => row.marketplace_id === "ATVPDKIKX0DER") ?? sellerAuthResult.data?.[0];
        if (sellerAuth?.seller_id) {
          const { data: fnskuRows, error: fnskuError } = await supabase
            .from("fnsku_map")
            .select("id, asin, seller_sku, updated_at")
            .eq("seller_id", sellerAuth.seller_id)
            .eq("marketplace_id", sellerAuth.marketplace_id)
            .or(`seller_sku.ilike.${pattern},asin.ilike.${pattern}`)
            .limit(50);
          if (cancelled) return;
          if (fnskuError) {
            console.warn("[ShipmentBuilder] FNSKU map search failed:", fnskuError);
          } else {
            rows.push(...((fnskuRows ?? []) as FnskuMapSearchRow[]).map(mapFnskuRowToInventoryRow));
          }
        }

        const directAsinQuery = /^[A-Z0-9]{10}$/.test(escaped.toUpperCase()) ? escaped.toUpperCase() : null;
        if (directAsinQuery && sellerAuth?.seller_id) {
          // Only expand siblings from authoritative Amazon source (fnsku_map).
          // Do NOT expand from created_listings — those are local drafts that
          // may not exist (or were deleted) in Seller Central.
          const [fnskuSiblingResult, liveListingsResult] = await Promise.all([
            supabase
              .from("fnsku_map")
              .select("id, asin, seller_sku, updated_at")
              .eq("seller_id", sellerAuth.seller_id)
              .eq("marketplace_id", sellerAuth.marketplace_id)
              .eq("asin", directAsinQuery)
              .limit(500),
            invokeEdgeFunction<{ listings?: LiveSellerListingSearchRow[] }>({
              functionName: "discover-asin-listings",
              body: { asin: directAsinQuery, marketplaceId: sellerAuth.marketplace_id },
              maxRetries: 0,
              context: { asin: directAsinQuery },
            }),
          ]);
          if (cancelled) return;
          if (!fnskuSiblingResult.error) {
            rows.push(...((fnskuSiblingResult.data ?? []) as FnskuMapSearchRow[]).map(mapFnskuRowToInventoryRow));
          }
          if (liveListingsResult.ok && liveListingsResult.data?.listings?.length) {
            rows.push(
              ...liveListingsResult.data.listings.map((listing) =>
                mapLiveSellerListingToInventoryRow(listing, directAsinQuery),
              ),
            );
          }
        }

        // Expand: for any ASIN found in initial results, fetch ALL sibling SKUs
        // for that ASIN so the user sees every variant they could ship under it
        // (mirrors the FNSKU label printing behavior that maps all SKUs per ASIN).
        const initialAsins = Array.from(
          new Set(
            (rows ?? [])
              .map((r) => (r.asin ?? "").trim())
              .filter((a) => a.length > 0),
          ),
        );
        if (initialAsins.length > 0) {
          let siblingQuery = supabase
            .from("inventory")
            .select(baseSelect)
            .in("asin", initialAsins)
            .limit(500);
          // Non-admin: scope to user. Admin path already uses unscoped query above
          // so we mirror that: if the original rows came from the user-scoped
          // query, keep it scoped; otherwise unscoped.
          if (!usedAdminInventorySearch) siblingQuery = siblingQuery.eq("user_id", user.id);
          const { data: siblings } = await siblingQuery;
          if (!cancelled && siblings) {
            const existingKeys = new Set(
              rows.map((r) => `${(r.sku ?? "").toUpperCase()}::${(r.asin ?? "").toUpperCase()}`),
            );
            for (const sib of siblings) {
              const key = `${(sib.sku ?? "").toUpperCase()}::${(sib.asin ?? "").toUpperCase()}`;
              if (!existingKeys.has(key)) {
                rows.push(sib);
                existingKeys.add(key);
              }
            }
          }

          // NOTE: We intentionally do NOT auto-expand siblings from `created_listings`.
          // Those are local drafts (from the Sync ASIN / Create Listing flow) that may
          // never have been pushed to Amazon, so listing them as ASIN siblings produces
          // ghost SKUs that don't exist in Seller Central. Only expand from authoritative
          // Amazon sources (inventory + fnsku_map). created_listings can still match when
          // the user types its exact SKU/ASIN in the initial query above.

          if (sellerAuth?.seller_id) {
            const { data: fnskuSiblings, error: fnskuSiblingError } = await supabase
              .from("fnsku_map")
              .select("id, asin, seller_sku, updated_at")
              .eq("seller_id", sellerAuth.seller_id)
              .eq("marketplace_id", sellerAuth.marketplace_id)
              .in("asin", initialAsins)
              .limit(500);
            if (cancelled) return;
            if (fnskuSiblingError) {
              console.warn("[ShipmentBuilder] FNSKU sibling search failed:", fnskuSiblingError);
            } else {
              rows.push(...((fnskuSiblings ?? []) as FnskuMapSearchRow[]).map(mapFnskuRowToInventoryRow));
            }

            // Mirror LabelPrinting: pull live Seller Central SKUs for every
            // ASIN found via the initial query (e.g. user searched by SKU and
            // matched one row — we still want every sibling SKU Amazon knows
            // about for that ASIN). Without this, only the locally-known SKU
            // shows up even though Seller Central has more.
            const liveResults = await Promise.all(
              initialAsins.slice(0, 5).map((asinForLive) =>
                invokeEdgeFunction<{ listings?: LiveSellerListingSearchRow[] }>({
                  functionName: "discover-asin-listings",
                  body: { asin: asinForLive, marketplaceId: sellerAuth.marketplace_id },
                  maxRetries: 0,
                  context: { asin: asinForLive },
                }).then((res) => ({ asin: asinForLive, res })),
              ),
            );
            if (cancelled) return;
            for (const { asin: asinForLive, res } of liveResults) {
              if (res.ok && res.data?.listings?.length) {
                rows.push(
                  ...res.data.listings.map((listing) =>
                    mapLiveSellerListingToInventoryRow(listing, asinForLive),
                  ),
                );
              }
            }
          }
        }

        // Cross-reference inventory to identify tombstoned (NOT_IN_CATALOG /
        // DELETED) SKUs. fnsku_map siblings have listing_status:null on their
        // own, so without this lookup deleted SKUs (e.g. ghost used SKUs) leak
        // back into the picker.
        const skuAsinKeys = Array.from(
          new Set(
            rows
              .map((r) => (r.sku ?? "").toUpperCase())
              .filter((s) => s.length > 0),
          ),
        );
        const tombstonedKeys = new Set<string>();
        if (skuAsinKeys.length > 0) {
          const { data: invStatusRows } = await supabase
            .from("inventory")
            .select("sku, asin, listing_status")
            .in("sku", skuAsinKeys)
            .limit(2000);
          for (const r of (invStatusRows ?? []) as Array<{ sku?: string | null; asin?: string | null; listing_status?: string | null }>) {
            const status = (r.listing_status ?? "").toUpperCase();
            if (status === "NOT_IN_CATALOG" || status === "DELETED") {
              tombstonedKeys.add(`${(r.sku ?? "").toUpperCase()}::${(r.asin ?? "").toUpperCase()}`);
            }
          }
        }

        const filtered = rows
          .filter((row) => row.asin && row.sku)
          .filter((row) => {
            const status = ((row as { listing_status?: string | null }).listing_status ?? "")
              .toUpperCase();
            if (status === "NOT_IN_CATALOG" || status === "DELETED") return false;
            const key = `${(row.sku ?? "").toUpperCase()}::${(row.asin ?? "").toUpperCase()}`;
            if (tombstonedKeys.has(key)) return false;
            // Hide Amazon-grading ghost SKUs (`amzn.gr.*`) unless this row is
            // currently ACTIVE with positive stock — sellers routinely delete
            // these returned/relisted SKUs in Seller Central but stale rows
            // linger locally and pollute the picker.
            const sku = (row.sku ?? "").toLowerCase();
            if (sku.startsWith("amzn.gr.")) {
              const r = row as { listing_status?: string | null; available?: number | null; reserved?: number | null; inbound?: number | null };
              const liveActive = (r.listing_status ?? "").toUpperCase() === "ACTIVE";
              const stock = Number(r.available ?? 0) + Number(r.reserved ?? 0) + Number(r.inbound ?? 0);
              if (!liveActive || stock <= 0) return false;
            }
            return true;
          });

        const dedupMap = new Map<string, typeof filtered[number]>();
        for (const row of filtered) {
          const key = `${(row.sku ?? "").toUpperCase()}::${(row.asin ?? "").toUpperCase()}`;
          const existing = dedupMap.get(key);
          if (!existing) {
            dedupMap.set(key, row);
            continue;
          }
          const rowOwned = (row as { user_id?: string }).user_id === user.id;
          const existingOwned = (existing as { user_id?: string }).user_id === user.id;
          if (rowOwned && !existingOwned) {
            dedupMap.set(key, row);
          } else if (rowOwned === existingOwned) {
            const rowScore = (row.available ?? 0) + (row.reserved ?? 0) + (row.inbound ?? 0);
            const existingScore = (existing.available ?? 0) + (existing.reserved ?? 0) + (existing.inbound ?? 0);
            if (rowScore > existingScore) dedupMap.set(key, row);
          }
        }

        // Image fallback: any row still missing image_url gets enriched from
        // the user's created_listings history (matches by ASIN, picks any row
        // that has an image). Use the base table, not active_created_listings:
        // FBA Shipment Builder still needs images for zero-stock/restock rows
        // that the active view may intentionally hide as ghost candidates.
        const dedupedRows = Array.from(dedupMap.values());
        const missingImageAsins = Array.from(
          new Set(
            dedupedRows
              .filter((r) => !(r.image_url && String(r.image_url).trim()))
              .map((r) => (r.asin ?? "").trim().toUpperCase())
              .filter((a) => /^[A-Z0-9]{10}$/.test(a)),
          ),
        );
        if (missingImageAsins.length > 0) {
          try {
            const { data: clImageRows } = await supabase
              .from("created_listings")
              .select("asin, image_url, updated_at")
              .eq("user_id", user.id)
              .in("asin", missingImageAsins)
              .not("image_url", "is", null)
              .order("updated_at", { ascending: false })
              .limit(500);
            if (!cancelled) {
              const imageByAsin = new Map<string, string>();
              for (const r of (clImageRows ?? []) as Array<{ asin?: string | null; image_url?: string | null }>) {
                const a = (r.asin ?? "").toUpperCase();
                const url = r.image_url && String(r.image_url).trim();
                if (a && url && !imageByAsin.has(a)) imageByAsin.set(a, url);
              }
              if (imageByAsin.size > 0) {
                for (let i = 0; i < dedupedRows.length; i++) {
                  const r = dedupedRows[i];
                  if (r.image_url && String(r.image_url).trim()) continue;
                  const fb = imageByAsin.get((r.asin ?? "").toUpperCase());
                  if (fb) dedupedRows[i] = { ...r, image_url: fb };
                }
              }
            }
          } catch (err) {
            console.warn("[ShipmentBuilder] created_listings image fallback failed:", err);
          }
        }

        // Newest first across inventory + created_listings so title searches
        // surface most recently created records at the top of the list.
        dedupedRows.sort((a, b) => {
          const at = a.created_at ? Date.parse(a.created_at) : 0;
          const bt = b.created_at ? Date.parse(b.created_at) : 0;
          return bt - at;
        });

        const mapped: ShipmentItem[] = dedupedRows.map(mapInventoryRowToShipmentItem);

        setSearchResults(mapped);
        lastFetchedQueryRef.current = query;
      } catch (err) {
        if (!cancelled) console.error("[ShipmentBuilder] Search failed:", err);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [searchQuery, user]);

  const selectedItems = useMemo(
    () => draft.items.filter((item) => item.savedToShipment === true || item.addedToShipment === true || item.qtyToShip > 0),
    [draft.items],
  );


  const unsavedShipmentItems = useMemo(
    () => draft.items.filter((item) => item.qtyToShip > 0 && item.savedToShipment !== true && !item.fbaBlocked),
    [draft.items],
  );

  // Ordered list of pack-row keys shown on step 6 (one per item per box, when qty>0)
  const packRowKeys = useMemo(() => {
    const keys: string[] = [];
    for (let boxIndex = 0; boxIndex < draft.numberOfBoxes; boxIndex++) {
      for (const item of selectedItems) {
        const qty = draft.identicalBoxes
          ? draft.boxQuantities[item.id]?.[0] ?? 0
          : draft.boxQuantities[item.id]?.[boxIndex] ?? 0;
        if (qty > 0) keys.push(`${item.id}-${boxIndex}`);
      }
    }
    return keys;
  }, [selectedItems, draft.numberOfBoxes, draft.identicalBoxes, draft.boxQuantities]);

  // Drop packed keys that no longer exist (qty changed, item removed, etc.)
  useEffect(() => {
    setDraft((current) => {
      if (!current.packedKeys?.length) return current;
      const valid = new Set(packRowKeys);
      const nextPackedKeys = current.packedKeys.filter((key) => valid.has(key));
      if (nextPackedKeys.length === current.packedKeys.length) return current;
      return { ...current, packedKeys: nextPackedKeys };
    });
    setHighlightedPackKey((prev) => (prev && packRowKeys.includes(prev) ? prev : null));
  }, [packRowKeys]);

  const allPacked = packRowKeys.length > 0 && packRowKeys.every((k) => packedKeys.has(k));

  // Wholesale/Hybrid mode reframes packing as carton configuration (no logic change).
  const { mode: businessMode } = useBusinessMode();
  const isWholesaleish = businessMode === "wholesale" || businessMode === "hybrid";
  const packVerb = isWholesaleish ? "Configured" : "Packed";
  const packActionLabel = isWholesaleish ? "Configure" : "Pack";
  const packActionDoneLabel = isWholesaleish ? "Configured" : "Packed";
  const reviewPackLabel = isWholesaleish ? "Configure Cartons" : "Review & Pack";
  const allPackedDoneLabel = isWholesaleish ? "All cartons configured ✓" : "All items packed ✓";
  const leftToPackLabel = (n: number) =>
    isWholesaleish ? `${n} SKU(s) left to configure` : `${n} item(s) left to pack`;
  const markPackedTitle = (packed: boolean) =>
    isWholesaleish
      ? (packed ? "Mark as not configured" : "Mark as configured")
      : (packed ? "Mark as not packed" : "Mark as packed");

  const togglePackedKey = (key: string) => {
    setDraft((current) => {
      const next = new Set(current.packedKeys ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, packedKeys: Array.from(next) };
    });
    setHighlightedPackKey(key);
  };

  const scrollToPackKey = (key: string) => {
    // Prefer the dialog row when the popup is open, otherwise scroll the inline list.
    const el = (reviewPackOpen ? dialogPackRowRefs.current[key] : null) ?? packRowRefs.current[key];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setHighlightedPackKey(key);
  };

  const navigatePackRow = (direction: "up" | "down") => {
    if (packRowKeys.length === 0) return;
    const currentIndex = highlightedPackKey ? packRowKeys.indexOf(highlightedPackKey) : -1;
    let nextIndex: number;
    if (direction === "down") {
      nextIndex = currentIndex < 0 ? 0 : Math.min(packRowKeys.length - 1, currentIndex + 1);
    } else {
      nextIndex = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1);
    }
    scrollToPackKey(packRowKeys[nextIndex]);
  };

  // Keyboard navigation for the packing list (Step 6 inline OR Review & Pack popup).
  useEffect(() => {
    if (draft.step !== 6 && !reviewPackOpen) return;
    if (packRowKeys.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigatePackRow("down");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigatePackRow("up");
      } else if (e.key === " " || e.code === "Space") {
        if (highlightedPackKey) {
          e.preventDefault();
          togglePackedKey(highlightedPackKey);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draft.step, packRowKeys, highlightedPackKey, reviewPackOpen]);

  const focusedShipment = useMemo(
    () => shipmentLibrary.find((entry) => entry.id === focusedShipmentId) ?? null,
    [shipmentLibrary, focusedShipmentId],
  );
  const showCloudLoadingState = user && !cloudLoadComplete && shipmentLibrary.length === 0;
  const draftShipments = useMemo(() => shipmentLibrary.filter((entry) => entry.status === "draft"), [shipmentLibrary]);
  const selectedDraftsForMerge = useMemo(
    () => draftShipments.filter((entry) => selectedLibraryIds.includes(entry.id)),
    [draftShipments, selectedLibraryIds],
  );
  const sortedDraftShipments = useMemo(() => {
    const entries = [...draftShipments];
    entries.sort((left, right) => {
      const leftName = (left.shipmentName || "Untitled shipment").toLowerCase();
      const rightName = (right.shipmentName || "Untitled shipment").toLowerCase();
      const leftCreated = new Date(left.createdAt).getTime();
      const rightCreated = new Date(right.createdAt).getTime();
      const leftUpdated = new Date(left.updatedAt).getTime();
      const rightUpdated = new Date(right.updatedAt).getTime();

      switch (draftSort) {
        case "name-asc":
          return leftName.localeCompare(rightName);
        case "name-desc":
          return rightName.localeCompare(leftName);
        case "created-asc":
          return leftCreated - rightCreated;
        case "created-desc":
          return rightCreated - leftCreated;
        case "updated-asc":
          return leftUpdated - rightUpdated;
        case "updated-desc":
        default:
          return rightUpdated - leftUpdated;
      }
    });
    return entries;
  }, [draftShipments, draftSort]);
  const continuedShipments = useMemo(() => shipmentLibrary.filter((entry) => entry.status === "continued"), [shipmentLibrary]);
  const [continuedDateFilter, setContinuedDateFilter] = useState<"all" | "week" | "month">("all");
  const filteredContinuedShipments = useMemo(() => {
    if (continuedDateFilter === "all") return continuedShipments;
    const now = new Date();
    const cutoff = new Date(now);
    if (continuedDateFilter === "week") cutoff.setDate(now.getDate() - 7);
    else cutoff.setMonth(now.getMonth() - 1);
    return continuedShipments.filter((entry) => {
      const ts = entry.continuedToAmazonAt ?? entry.updatedAt;
      const d = ts ? new Date(ts) : null;
      return d && !isNaN(d.getTime()) && d >= cutoff;
    });
  }, [continuedShipments, continuedDateFilter]);
  const syncedShipments = useMemo(() => shipmentLibrary.filter((entry) => entry.status === "synced" || entry.status === "completed"), [shipmentLibrary]);
  const archivedShipments = useMemo(() => shipmentLibrary.filter((entry) => entry.status === "archived"), [shipmentLibrary]);
  const canMergeDrafts = selectedLibraryIds.length > 1;
  const totalUnits = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.qtyToShip, 0),
    [selectedItems],
  );
  const getBoxArray = (itemId: string) => {
    const existing = draft.boxQuantities[itemId] ?? [];
    return Array.from({ length: draft.numberOfBoxes }, (_, index) => existing[index] ?? 0);
  };

  const totalSkus = selectedItems.length;

  // Fetch unit costs for the ASINs currently in the shipment (Contract A).
  useEffect(() => {
    const collected = new Set<string>();
    for (const it of selectedItems) {
      const a = (it.asin ?? "").trim();
      if (a) collected.add(a);
    }
    for (const entry of shipmentLibrary) {
      for (const it of entry.items ?? []) {
        const a = (it.asin ?? "").trim();
        if (a && (it.qtyToShip ?? 0) > 0) collected.add(a);
      }
    }
    const missing = Array.from(collected).filter((a) => costByAsin[a] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // Unit-cost precedence (since 2026-09-17), the same chain Inventory
      // Valuation and the repricer use:
      //   asin_cost_overrides -> COG on record -> created_listings -> inventory.cost
      //
      // This page used the newest created_listings row alone, so a shipment of
      // a repeat-purchase product was valued at whatever the last lot cost.
      // Measured over the seller's 95 saved drafts (1,017 item rows, 31,643
      // units): 488 rows change and the total moves $316,211.51 -> $302,983.69.
      // The largest were the shared-lot Funko costs the COG exists to correct
      // (B0G4B3117X $14.56 -> $7.75).
      //
      // COG is read through asin_cog_for_repricer, which drops COGs flagged
      // needs_review and unreviewed placeholder COGs under $2, so a $1.00
      // import lot can never undervalue a shipment.
      //
      // Chunked: `in()` on a few hundred ASINs is fine, but a large library
      // would blow the URL length, and PostgREST caps any response at 1,000
      // rows however many ASINs were asked for.
      const CHUNK = 150;
      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
      const today = new Date().toISOString().slice(0, 10);

      const next: Record<string, number> = {};
      const setIfAbsent = (asin: string, unit: number) => {
        const key = asin.trim();
        if (key && next[key] === undefined && Number.isFinite(unit) && unit > 0) next[key] = unit;
      };

      try {
        for (const chunk of chunks) {
          // 1) COG on record (first value wins, so this order IS the precedence)
          const { data: cog } = await supabase
            .from("asin_cog_for_repricer")
            .select("asin, unit_cost")
            .in("asin", chunk);
          if (cancelled) return;
          for (const row of (cog || []) as Array<{ asin: string; unit_cost: number }>) {
            setIfAbsent(row.asin, Number(row.unit_cost));
          }

          // 2) cost overrides, only for ASINs with no usable COG. Swapped
          // 2026-09-17: 26 of 27 overrides were auto-saved from purchases and
          // hid seller COGs (B0G54FYGXQ $16.70 vs a $9.10 COG).
          const { data: ovr } = await supabase
            .from("asin_cost_overrides")
            .select("asin, unit_cost, effective_from, created_at")
            .in("asin", chunk)
            .lte("effective_from", today)
            .gt("unit_cost", 0)
            .order("effective_from", { ascending: false })
            .order("created_at", { ascending: false });
          if (cancelled) return;
          for (const row of (ovr || []) as Array<{ asin: string; unit_cost: number }>) {
            setIfAbsent(row.asin, Number(row.unit_cost));
          }

          // 3) created_listings (newest row wins) — unchanged rule, now a fallback
          const { data: cl } = await supabase
            .from("created_listings")
            .select("asin, amount, cost, units, updated_at")
            .in("asin", chunk)
            .order("updated_at", { ascending: false });
          if (cancelled) return;
          const seenCl = new Set<string>();
          for (const row of (cl || []) as Array<{ asin: string | null; amount: number | null; cost: number | null; units: number | null }>) {
            const asin = (row.asin ?? "").trim();
            if (!asin || seenCl.has(asin)) continue; // first row wins (latest updated_at)
            seenCl.add(asin);
            let unit = 0;
            if (typeof row.amount === "number" && row.amount >= 0) unit = row.amount;
            else if ((row.cost ?? 0) > 0 && (row.units ?? 0) > 0) unit = (row.cost as number) / (row.units as number);
            setIfAbsent(asin, unit);
          }

          // 4) inventory.cost (already per-unit) for anything still unpriced
          const stillMissing = chunk.filter((a) => next[a] === undefined);
          if (stillMissing.length > 0) {
            const { data: inv } = await supabase
              .from("inventory")
              .select("asin, cost")
              .in("asin", stillMissing)
              .gt("cost", 0);
            if (cancelled) return;
            for (const row of (inv || []) as Array<{ asin: string | null; cost: number | null }>) {
              setIfAbsent(row.asin ?? "", Number(row.cost));
            }
          }
        }
      } catch (e) {
        // Non-fatal: whatever resolved still applies, the rest stays $0 and the
        // "missing costs count as $0" note explains it.
        console.error("[ShipmentBuilder] unit cost lookup failed:", e);
      }
      if (cancelled) return;
      for (const a of missing) if (next[a] === undefined) next[a] = 0;
      setCostByAsin((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedItems, shipmentLibrary, costByAsin]);

  const computeEntryTotalCost = (items: Array<{ asin?: string | null; qtyToShip?: number }>) =>
    items.reduce(
      (sum, it) => sum + (costByAsin[(it.asin ?? "").trim()] ?? 0) * (it.qtyToShip ?? 0),
      0,
    );

  const totalCost = useMemo(
    () =>
      selectedItems.reduce(
        (sum, item) => sum + (costByAsin[(item.asin ?? "").trim()] ?? 0) * (item.qtyToShip ?? 0),
        0,
      ),
    [selectedItems, costByAsin],
  );
  const complianceMissingExpirationItems = useMemo(
    () => selectedItems.filter((item) => item.expirationRequired && !item.expirationDate),
    [selectedItems],
  );
  const complianceHasInvalidQty = useMemo(
    () => selectedItems.some((item) => item.qtyToShip <= 0),
    [selectedItems],
  );
  const canContinueFromCompliance =
    selectedItems.length > 0 && unsavedShipmentItems.length === 0 && !complianceHasInvalidQty && complianceMissingExpirationItems.length === 0;
  const boxQuantityMismatchItems = useMemo(
    () =>
      selectedItems
        .map((item) => {
          const quantities = getBoxArray(item.id);
          const totalInBoxes = draft.identicalBoxes
            ? (quantities[0] ?? 0) * draft.numberOfBoxes
            : quantities.reduce((sum, qty) => sum + qty, 0);

          return {
            ...item,
            totalInBoxes,
            matchesShipmentQty: totalInBoxes === item.qtyToShip,
          };
        })
        .filter((item) => !item.matchesShipmentQty),
    [selectedItems, draft.identicalBoxes, draft.numberOfBoxes, draft.boxQuantities],
  );
  const canContinueFromBoxes = draft.numberOfBoxes > 0 && unsavedShipmentItems.length === 0 && boxQuantityMismatchItems.length === 0;

  useEffect(() => {
    setSelectedComplianceItemIds((current) => current.filter((itemId) => selectedItems.some((item) => item.id === itemId)));
  }, [selectedItems]);

  // When there's only one box, auto-fill Box 1 with each SKU's full Qty to Ship.
  // When the user switches to more than one box, clear all box quantities so they can re-enter.
  useEffect(() => {
    if (selectedItems.length === 0) return;

    setDraft((current) => {
      if (current.numberOfBoxes === 1) {
        const next = { ...current.boxQuantities };
        let changed = false;
        current.items.forEach((item) => {
          if (item.qtyToShip <= 0) return;
          const existing = next[item.id]?.[0] ?? 0;
          if (existing !== item.qtyToShip) {
            next[item.id] = [item.qtyToShip];
            changed = true;
          }
        });
        if (!changed) return current;
        return { ...current, boxQuantities: next };
      }

      // More than one box: reset all per-box quantities to zero so the user fills them in fresh.
      const next: Record<string, number[]> = {};
      let changed = false;
      current.items.forEach((item) => {
        const empty = Array.from({ length: current.numberOfBoxes }, () => 0);
        next[item.id] = empty;
        const previous = current.boxQuantities[item.id];
        if (!previous || previous.some((qty) => qty !== 0) || previous.length !== current.numberOfBoxes) {
          changed = true;
        }
      });
      if (!changed) return current;
      return { ...current, boxQuantities: next };
    });
  }, [draft.numberOfBoxes, selectedItems]);

  // For single-box shipments, prefill default dimensions (27x17x15 in) and weight (50 lb)
  // only when the user hasn't entered any values yet (all zero). Does not apply to multi-box.
  useEffect(() => {
    if (draft.numberOfBoxes !== 1) return;
    setDraft((current) => {
      if (current.numberOfBoxes !== 1) return current;
      const dim = current.sameDimensions;
      const wt = current.sameWeight;
      const dimsEmpty = (dim.length ?? 0) === 0 && (dim.width ?? 0) === 0 && (dim.height ?? 0) === 0;
      const weightEmpty = (wt.weight ?? 0) === 0;
      if (!dimsEmpty && !weightEmpty) return current;

      const nextSameDimensions = dimsEmpty
        ? { length: 27, width: 17, height: 15, unit: dim.unit ?? "in" }
        : dim;
      const nextSameWeight = weightEmpty
        ? { weight: 50, unit: wt.unit ?? "lb" }
        : wt;

      return {
        ...current,
        sameDimensions: nextSameDimensions,
        boxDimensions: cloneAllBoxDimensions(current.numberOfBoxes, nextSameDimensions),
        sameWeight: nextSameWeight,
        boxWeights: cloneAllBoxWeights(current.numberOfBoxes, nextSameWeight),
      };
    });
  }, [draft.numberOfBoxes]);

  const scrollToComplianceItem = (itemId: string) => {
    const row = document.getElementById(`compliance-row-${itemId}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (row instanceof HTMLElement) {
      row.focus({ preventScroll: true });
    }
  };

  const scrollToBoxItem = (itemId: string) => {
    const row = document.getElementById(`box-row-${itemId}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (row instanceof HTMLElement) {
      row.focus({ preventScroll: true });
    }
  };

  const filteredItems = useMemo(() => {
    // Use the committed `searchQuery` (set on Enter / Search button) so typing
    // alone never filters the table — matches the inventory fetch behavior.
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return draft.items.filter((item) => item.qtyToShip > 0 || item.addedToShipment);
    }

    const draftByKey = new Map(draft.items.map((item) => [getSkuIdentity(item), item]));
    const searchOrdered = searchResults
      .filter((item) => [item.sku, item.asin, item.title].some((value) => value.toLowerCase().includes(query)))
      .map((item) => draftByKey.get(getSkuIdentity(item)) ?? item);
    const seen = new Set(searchOrdered.map((item) => getSkuIdentity(item)));
    const matchingDraftOnly = draft.items.filter((item) =>
      !seen.has(getSkuIdentity(item)) &&
      [item.sku, item.asin, item.title].some((value) => value.toLowerCase().includes(query)),
    );
    return [...searchOrdered, ...matchingDraftOnly];
  }, [draft.items, searchQuery, searchResults]);

  const allComplianceItemsSelected =
    selectedItems.length > 0 && selectedItems.every((item) => selectedComplianceItemIds.includes(item.id));

  const toggleComplianceSelection = (itemId: string, checked: boolean) => {
    setSelectedComplianceItemIds((current) =>
      checked ? Array.from(new Set([...current, itemId])) : current.filter((id) => id !== itemId),
    );
  };

  const toggleAllComplianceSelection = (checked: boolean) => {
    setSelectedComplianceItemIds(checked ? selectedItems.map((item) => item.id) : []);
  };

  const applyExpirationRequirementBulk = (itemIds: string[], expirationRequired: boolean) => {
    if (itemIds.length === 0) return;

    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        itemIds.includes(item.id)
          ? {
              ...item,
              expirationRequired,
              expirationManualOverride: true,
              expirationDate: expirationRequired ? item.expirationDate : "",
            }
          : item,
      ),
    }));
  };

  const markAllAsNotRequired = () => {
    applyExpirationRequirementBulk(selectedItems.map((item) => item.id), false);
  };

  const markSelectedAsRequiresExpiration = () => {
    applyExpirationRequirementBulk(selectedComplianceItemIds, true);
  };

  const [isSyncingImages, setIsSyncingImages] = useState(false);

  const syncImagesForItems = async (itemIds: string[]) => {
    if (!user?.id) {
      toast.error("Not signed in");
      return;
    }
    const targets = draft.items.filter(
      (it) => itemIds.includes(it.id) && (!it.imageUrl || !String(it.imageUrl).trim())
    );
    if (targets.length === 0) {
      toast.info("All selected items already have images");
      return;
    }
    setIsSyncingImages(true);
    try {
      const asins = Array.from(new Set(targets.map((t) => (t.asin ?? "").trim()).filter(Boolean)));
      const skus = Array.from(new Set(targets.map((t) => (t.sku ?? "").trim()).filter(Boolean)));

      const imageByAsin = new Map<string, string>();
      const imageBySku = new Map<string, string>();

      // 1) Inventory (prefer rows that actually have an image)
      if (asins.length > 0) {
        const { data: invRows } = await supabase
          .from("inventory")
          .select("asin, sku, image_url")
          .eq("user_id", user.id)
          .in("asin", asins);
        for (const r of invRows ?? []) {
          const url = (r as any).image_url;
          if (url && String(url).trim()) {
            if ((r as any).asin && !imageByAsin.has((r as any).asin)) imageByAsin.set((r as any).asin, url);
            if ((r as any).sku && !imageBySku.has((r as any).sku)) imageBySku.set((r as any).sku, url);
          }
        }
      }

      // 2) created_listings by SKU
      if (skus.length > 0) {
        const { data: clRows } = await supabase
          .from("created_listings")
          .select("sku, asin, image_url")
          .eq("user_id", user.id)
          .in("sku", skus);
        for (const r of clRows ?? []) {
          const url = (r as any).image_url;
          if (url && String(url).trim()) {
            if ((r as any).sku && !imageBySku.has((r as any).sku)) imageBySku.set((r as any).sku, url);
            if ((r as any).asin && !imageByAsin.has((r as any).asin)) imageByAsin.set((r as any).asin, url);
          }
        }
      }

      // 3) Fallback: SP-API catalog lookup per missing ASIN
      const stillMissing = targets.filter(
        (t) => !imageByAsin.get((t.asin ?? "").trim()) && !imageBySku.get((t.sku ?? "").trim())
      );
      const uniqueMissingAsins = Array.from(
        new Set(stillMissing.map((t) => (t.asin ?? "").trim()).filter((a) => /^[A-Z0-9]{10}$/.test(a)))
      );
      for (const asin of uniqueMissingAsins) {
        try {
          const { data, error } = await supabase.functions.invoke("import-asin-from-seller-central", {
            body: { asin },
          });
          if (!error && data?.image_url) {
            imageByAsin.set(asin, data.image_url);
          }
        } catch (err) {
          console.warn("[sync-images] SP-API lookup failed for", asin, err);
        }
      }

      // Apply to draft
      let updated = 0;
      setDraft((current) => ({
        ...current,
        items: current.items.map((item) => {
          if (!itemIds.includes(item.id)) return item;
          if (item.imageUrl && String(item.imageUrl).trim()) return item;
          const next =
            imageByAsin.get((item.asin ?? "").trim()) ||
            imageBySku.get((item.sku ?? "").trim()) ||
            null;
          if (!next) return item;
          updated += 1;
          return { ...item, imageUrl: next, image_url: next } as ShipmentItem;
        }),
      }));

      if (updated > 0) {
        toast.success(`Synced images for ${updated} of ${targets.length} item${targets.length === 1 ? "" : "s"}`);
      } else {
        toast.warning("No images found in Inventory, Created Listings, or Seller Central");
      }
    } catch (err: any) {
      console.error("[sync-images] failed", err);
      toast.error(err?.message || "Failed to sync images");
    } finally {
      setIsSyncingImages(false);
    }
  };

  const syncImagesForSelected = () => {
    const ids = selectedComplianceItemIds.length > 0
      ? selectedComplianceItemIds
      : selectedItems.map((it) => it.id);
    syncImagesForItems(ids);
  };

  const ensureBoxStructures = (count: number) => {
    setDraft((current) => {
      const normalized = normalizeBoxArrays(count, current.boxDimensions, current.boxWeights);
      const boxQuantities = { ...current.boxQuantities };

      current.items.forEach((item) => {
        const existing = boxQuantities[item.id] ?? [];
        const next = Array.from({ length: count }, (_, index) => existing[index] ?? 0);
        boxQuantities[item.id] = next;
      });

      const nextIdenticalBoxes = count <= 1 ? false : current.identicalBoxes || count > 1;

      return {
        ...current,
        numberOfBoxes: count,
        identicalBoxes: nextIdenticalBoxes,
        boxDimensions: nextIdenticalBoxes
          ? cloneAllBoxDimensions(count, current.applySameDimensions ? current.sameDimensions : normalized.boxDimensions[0])
          : normalized.boxDimensions,
        boxWeights: nextIdenticalBoxes
          ? cloneAllBoxWeights(count, current.allowPerBoxWeight ? normalized.boxWeights[0] : current.sameWeight)
          : normalized.boxWeights,
        boxQuantities,
      };
    });
  };

  const initializeDraft = () => {
    if (!draft.shipmentName.trim()) {
      toast.error("Shipment name is required");
      return;
    }

    const nextDraft = {
      ...draft,
      id: draft.id || createDraftId(),
      step: 2 as StepId,
      status: "draft" as ShipmentStatus,
      items: draft.items.length > 0 ? draft.items : inventory,
      updatedAt: new Date().toISOString(),
    };

    // Save the new draft into the library, but DO NOT open it.
    // Reset the active editor and send the user to the Drafts list
    // so they can see the new entry and choose to open it.
    setShipmentLibrary((current) => upsertShipmentRecord(current, nextDraft, user?.id));

    const fresh = buildEmptyDraft();
    const normalized = {
      ...fresh,
      items: inventory.map((item) => ({
        ...item,
        qtyToShip: 0,
        expirationRequired: false,
        expirationDate: "",
        expirationManualOverride: false,
        expirationDetectionReason: null,
      })),
    };
    setDraft(normalized);
    setAutosaveReady(false);
    setRestoredDraft(false);
    setFocusedShipmentId(nextDraft.id);
    setWorkspaceSection("drafts");
    localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
    toast.success("Draft created", {
      description: "Find it in your Drafts list and open it when ready.",
    });
  };

  const resetDraft = () => {
    const fresh = buildEmptyDraft();
    const normalized = {
      ...fresh,
      items: inventory.map((item) => ({
        ...item,
        qtyToShip: 0,
        expirationRequired: false,
        expirationDate: "",
        expirationManualOverride: false,
        expirationDetectionReason: null,
      })),
    };
    setDraft(normalized);
    setRestoredDraft(false);
    setAutosaveReady(false);
    setFocusedShipmentId(normalized.id);
    setWorkspaceSection("new");
    setSearch(""); setSearchQuery("");
    localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
    toast.success("Started a new shipment draft");
  };

  const openShipmentDraft = (entry: ShipmentDraftState) => {
    const hydrated = {
      ...entry,
      items: hydrateDraftItems(inventory, entry.items),
    };

    setDraft(hydrated);
    setAutosaveReady(true);
    setRestoredDraft(true);
    setFocusedShipmentId(entry.id);
    setWorkspaceSection("new");
    setSearch(""); setSearchQuery("");
    localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify(hydrated));
    toast.success("Shipment opened");
  };

  const renameShipment = (entry: ShipmentDraftState) => {
    setRenameDialogEntry(entry);
    setRenameValue(entry.shipmentName || "");
  };

  const confirmRenameShipment = () => {
    if (!renameDialogEntry) return;
    const nextName = renameValue.trim();
    if (!nextName) return;

    const updated = { ...renameDialogEntry, shipmentName: nextName, updatedAt: new Date().toISOString() };
    setShipmentLibrary((current) => upsertShipmentRecord(current, updated, user?.id));
    if (draft.id === renameDialogEntry.id) {
      setDraft((current) => ({ ...current, shipmentName: nextName, updatedAt: updated.updatedAt }));
      localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify({ ...draft, shipmentName: nextName, updatedAt: updated.updatedAt }));
    }
    setRenameDialogEntry(null);
    setRenameValue("");
    toast.success("Shipment renamed");
  };

  const duplicateShipment = (entry: ShipmentDraftState) => {
    const duplicate: ShipmentDraftState = {
      ...entry,
      id: createDraftId(),
      createdAt: new Date().toISOString(),
      shipmentName: `${entry.shipmentName || "Untitled shipment"} Copy`,
      status: "draft",
      inboundPlanId: undefined,
      shipmentId: undefined,
      shipmentIds: undefined,
      placementOptionId: undefined,
      amazonShipmentCreatedAt: undefined,
      amazonWriteAccessCode: undefined,
      amazonWriteAccessMessage: undefined,
      amazonWorkflowMessage: undefined,
      amazonStepDiagnostics: undefined,
      syncStatusNote: undefined,
      archivedAt: undefined,
      continuedToAmazonAt: undefined,
      amazonPlanStatus: undefined,
      amazonOperationId: undefined,
      updatedAt: new Date().toISOString(),
    };

    setShipmentLibrary((current) => upsertShipmentRecord(current, duplicate, user?.id));
    setWorkspaceSection("drafts");
    openShipmentDraft(duplicate);
    toast.success("New editable draft created from this shipment");
  };

  const deleteShipment = (entry: ShipmentDraftState) => {
    setShipmentLibrary((current) => removeShipmentRecord(current, entry.id, user?.id));
    setSelectedLibraryIds((current) => current.filter((id) => id !== entry.id));
    if (focusedShipmentId === entry.id) {
      setFocusedShipmentId(null);
    }
    if (draft.id === entry.id) {
      localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
      resetDraft();
    }
    toast.success("Shipment deleted");
  };

  const archiveShipment = (entry: ShipmentDraftState) => {
    const updated: ShipmentDraftState = {
      ...entry,
      status: "archived",
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setShipmentLibrary((current) => upsertShipmentRecord(current, updated, user?.id));
    if (draft.id === entry.id) {
      setDraft((current) => ({ ...current, status: "archived", archivedAt: updated.archivedAt, updatedAt: updated.updatedAt }));
    }
    toast.success("Shipment archived");
  };

  const markShipmentCompleted = (entry: ShipmentDraftState) => {
    const updated: ShipmentDraftState = {
      ...entry,
      status: "completed",
      syncStatusNote: "Marked completed in InventorySprint",
      updatedAt: new Date().toISOString(),
    };
    setShipmentLibrary((current) => upsertShipmentRecord(current, updated, user?.id));
    if (draft.id === entry.id) {
      setDraft((current) => ({ ...current, status: "completed", syncStatusNote: updated.syncStatusNote, updatedAt: updated.updatedAt }));
    }
    toast.success("Shipment marked completed");
  };

  const toggleLibrarySelection = (draftId: string, checked: boolean) => {
    setSelectedLibraryIds((current) =>
      checked ? Array.from(new Set([...current, draftId])) : current.filter((id) => id !== draftId),
    );
  };

  const openMergeDialog = () => {
    if (!canMergeDrafts) {
      toast.error("Select at least two drafts to merge");
      return;
    }

    setMergeName(buildMergedShipmentName(selectedDraftsForMerge));
    setMergeDialogOpen(true);
  };

  const mergeSelectedDrafts = () => {
    if (selectedDraftsForMerge.length < 2) {
      toast.error("Select at least two drafts to merge");
      return;
    }

    const mergedDraft = mergeDraftsIntoShipment(selectedDraftsForMerge, mergeName);
    const hydrated = {
      ...mergedDraft,
      items: hydrateDraftItems(inventory, mergedDraft.items),
    };

    setShipmentLibrary((current) => upsertShipmentRecord(current, hydrated, user?.id));
    setSelectedLibraryIds([]);
    setDraft(hydrated);
    setAutosaveReady(true);
    setFocusedShipmentId(hydrated.id);
    setWorkspaceSection("new");
    setMergeDialogOpen(false);
    localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify(hydrated));
    toast.success("Drafts merged. Rebuild the box setup before syncing to Amazon");
  };

  const updateItem = (itemId: string, updater: (item: ShipmentItem) => ShipmentItem) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === itemId ? updater(item) : item)),
    }));
  };

  const updateQtyToShip = (itemId: string, value: string) => {
    const qty = Math.max(0, Math.floor(safeNumber(value)));
    const currentScrollTop = productTableScrollRef.current?.scrollTop ?? null;
    // Mark a local edit immediately so the cross-device cloud sync cannot
    // overwrite the user's typing during the 5s grace window.
    lastLocalDraftChangeAtRef.current = Date.now();

    // FBA shipment safety gate — blocked ASINs (manufacturer barcode / no valid FNSKU)
    // must never reach the FBA shipment workflow. Allow qty=0 (clears).
    if (qty > 0) {
      const candidate =
        draft.items.find((i) => i.id === itemId) ??
        searchResults.find((i) => i.id === itemId);
      if (candidate?.fbaBlocked) {
        toast.error(
          "This ASIN is blocked from FBA shipment because it uses manufacturer barcode or has no valid Amazon FNSKU.",
        );
        // Fire a fresh re-check in the background so the user can fix it in
        // Seller Central and try again without a hard reload.
        if (candidate.asin) {
          supabase.functions
            .invoke("check-fba-listing-eligibility", {
              body: { asin: candidate.asin.toUpperCase(), marketplace: "US", force: true },
            })
            .then(({ data }) => {
              if (data && (data as any).eligible) {
                setDraft((current) => ({
                  ...current,
                  items: current.items.map((it) =>
                    it.asin === candidate.asin
                      ? { ...it, fbaBlocked: false, fbaBlockReason: null }
                      : it,
                  ),
                }));
                toast.success("FBA eligibility re-checked: ASIN is now eligible. Try again.");
              }
            })
            .catch(() => {});
        }
        return;
      }
    }

    setDraft((current) => {
      const exists = current.items.some((item) => item.id === itemId);
      if (exists) {
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  qtyToShip: qty,
                  // Once added, keep the row pinned to the shipment even if
                  // qty is later cleared to 0.
                  addedToShipment: item.addedToShipment || item.qtyToShip > 0 || qty > 0,
                  // Editing qty always invalidates the prior Save — user must
                  // press Save again to confirm. Qty=0 also resets save state.
                  savedToShipment: false,
                }
              : item,
          ),
        };
      }
      // Item is only in search results (not yet merged into draft.items).
      // Append it so the qty edit isn't lost. Starts unsaved — user must
      // press the per-row Save button to carry it into later steps.
      const fromSearch = searchResults.find((item) => item.id === itemId);
      if (!fromSearch) return current;
      return {
        ...current,
        items: [...current.items, { ...fromSearch, qtyToShip: qty, addedToShipment: qty > 0, savedToShipment: false }],
      };
    });
    if (currentScrollTop !== null) {
      requestAnimationFrame(() => {
        if (productTableScrollRef.current) {
          productTableScrollRef.current.scrollTop = currentScrollTop;
        }
      });
    }
  };

  // Confirm a row — marks it as Saved so it carries into Prep / Boxes / Plan.
  const setItemGating = (itemId: string, patch: Pick<ShipmentItem, "gatingStatus" | "gatingReason">) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }));
    setSearchResults((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  };

  // Fired the moment a row is Saved — checks Amazon's LIVE Listings
  // Restrictions API for this ASIN (via fetch-listing-snapshot, the same
  // gating check the analyzer/extension use) so a restricted-brand ASIN is
  // flagged here in Step 2 instead of failing later at shipment-plan
  // submission. Non-blocking: the save itself already happened, this only
  // updates the badge once the check resolves.
  const checkAsinGating = async (itemId: string, asin: string) => {
    setItemGating(itemId, { gatingStatus: "checking", gatingReason: null });
    try {
      const { data, error } = await supabase.functions.invoke("fetch-listing-snapshot", {
        body: { asin: asin.toUpperCase(), marketplaceId: "ATVPDKIKX0DER" },
      });
      if (error || !data) {
        setItemGating(itemId, { gatingStatus: "unknown", gatingReason: null });
        return;
      }
      const status = String((data as any).gatingStatus || "").toUpperCase();
      if (status === "APPROVED") {
        setItemGating(itemId, { gatingStatus: "approved", gatingReason: null });
      } else if (status === "APPROVAL_REQUIRED" || status === "RESTRICTED" || status === "NOT_ELIGIBLE") {
        const reasons = (data as any).gatingReasons;
        setItemGating(itemId, {
          gatingStatus: "restricted",
          gatingReason: Array.isArray(reasons) && reasons[0] ? reasons[0] : "Amazon requires approval to list this ASIN in this brand.",
        });
      } else {
        setItemGating(itemId, { gatingStatus: "unknown", gatingReason: null });
      }
    } catch {
      setItemGating(itemId, { gatingStatus: "unknown", gatingReason: null });
    }
  };

  const saveItemRow = (itemId: string) => {
    let savedAsin: string | null = null;
    setDraft((current) => {
      const target = current.items.find((item) => item.id === itemId);
      if (!target || target.qtyToShip <= 0) {
        toast.error("Enter a quantity greater than 0 before saving this product.");
        return current;
      }
      if (target.fbaBlocked) {
        toast.error("FBA-blocked items cannot be saved to this shipment.");
        return current;
      }
      savedAsin = target.asin;
      return {
        ...current,
        items: current.items.map((item) =>
          item.id === itemId
            ? { ...item, savedToShipment: true, addedToShipment: true }
            : item,
        ),
      };
    });
    // Clear the active title/ASIN search so unrelated search extras disappear
    // from Step 2 and only the saved row (plus other already-in-draft rows)
    // remain visible.
    setSearchQuery("");
    setSearchResults([]);
    toast.success("Saved to shipment");
    if (savedAsin) {
      checkAsinGating(itemId, savedAsin);
    }
  };


  // (removeItemFromShipment is defined later — see below.)

  const handleAsinSync = async () => {
    const trimmed = asinSyncValue.trim().toUpperCase();
    if (!trimmed) {
      toast.error("Enter an ASIN to sync");
      return;
    }
    if (!user) {
      toast.error("You must be signed in");
      return;
    }
    setAsinSyncBusy(true);
    setAsinSyncResult(null);
    try {
      const userSku = asinSyncSku.trim();
      let skus: string[] = [];

      if (userSku) {
        // User explicitly provided a SKU — sync exactly that one, no discovery.
        skus = [userSku];
      } else {
        // Discover SKU(s) for this ASIN — rescue-inventory-asin requires {asin, sku}.
        // Look in inventory first, then fall back to created_listings (newly added listings
        // that haven't synced to inventory yet).
        const [{ data: invSkuRows }, { data: createdSkuRows }] = await Promise.all([
          supabase
            .from("inventory")
            .select("sku")
            .eq("user_id", user.id)
            .eq("asin", trimmed),
          supabase
            .from("created_listings")
            .select("sku")
            .eq("user_id", user.id)
            .eq("asin", trimmed),
        ]);

        skus = Array.from(
          new Set(
            [...(invSkuRows ?? []), ...(createdSkuRows ?? [])]
              .map((r: any) => (r?.sku ?? "").toString().trim())
              .filter((s) => s.length > 0),
          ),
        );

        if (skus.length === 0) {
          setAsinSyncResult({
            ok: false,
            message:
              "No SKU found for this ASIN. Enter the SKU manually below, or create the listing in Product Library first.",
          });
          toast.error("No SKU found for this ASIN — enter SKU manually");
          return;
        }
      }

      // Run rescue per SKU (usually just one). Tolerate per-SKU failures.
      const rescueResults = await Promise.all(
        skus.map((sku) =>
          invokeEdgeFunction({
            functionName: "rescue-inventory-asin",
            body: { asin: trimmed, sku },
          }),
        ),
      );
      const anyOk = rescueResults.some((r) => r.ok);
      if (!anyOk) {
        const firstErr = rescueResults.find((r) => !r.ok)?.errorMessage || "Sync failed";
        throw new Error(firstErr);
      }

      const isPlaceholderProductTitle = (title: string | null | undefined, sku: string, asin: string) => {
        const normalized = (title ?? "").trim();
        if (!normalized) return true;
        const upper = normalized.toUpperCase();
        return upper === sku.trim().toUpperCase() || upper === asin.trim().toUpperCase();
      };

      const rescueTitleBySku = new Map<string, string>();
      rescueResults.forEach((result, index) => {
        const sku = skus[index];
        if (!result?.ok || !sku) return;
        const payload = (result as any).data ?? {};
        const responseTitleCandidates = [
          payload?.post_write_db?.title,
          payload?.attempted_write_payload?.title,
          payload?.matched_summary_identity?.product_name,
          payload?.verification_trace?.matched_summary_identity?.product_name,
          payload?.raw_summary_excerpt?.productName,
          payload?.raw_summary_excerpt?.title,
        ];
        const resolvedTitle = responseTitleCandidates.find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        if (resolvedTitle) rescueTitleBySku.set(sku, resolvedTitle);
      });

      const listingMetaBySku = new Map<string, { title: string | null; imageUrl: string | null }>();
      const listingMetaQuery = supabase
        .from("created_listings")
        .select("sku, title, image_url")
        .eq("user_id", user.id)
        .eq("asin", trimmed);
      const { data: listingMetaRows, error: listingMetaError } =
        skus.length === 1
          ? await listingMetaQuery.eq("sku", skus[0])
          : await listingMetaQuery.in("sku", skus);

      if (listingMetaError) {
        console.warn("[ShipmentBuilder] Failed to load created listing metadata for ASIN sync", listingMetaError);
      } else {
        for (const row of listingMetaRows ?? []) {
          const sku = (row?.sku ?? "").toString().trim();
          if (!sku) continue;

          const current = listingMetaBySku.get(sku);
          const nextTitle = typeof row?.title === "string" && row.title.trim().length > 0 ? row.title : null;
          const nextImage = typeof row?.image_url === "string" && row.image_url.trim().length > 0 ? row.image_url : null;

          if (!current) {
            listingMetaBySku.set(sku, { title: nextTitle, imageUrl: nextImage });
            continue;
          }

          listingMetaBySku.set(sku, {
            title: current.title ?? nextTitle,
            imageUrl: current.imageUrl ?? nextImage,
          });
        }
      }

      const resolveDisplayTitle = (baseTitle: string | null | undefined, sku: string, asin: string) => {
        const listingTitle = listingMetaBySku.get(sku)?.title;
        const rescueTitle = rescueTitleBySku.get(sku);

        if (!isPlaceholderProductTitle(baseTitle, sku, asin)) {
          return (baseTitle ?? "").trim();
        }

        return listingTitle || rescueTitle || baseTitle || sku || asin || "Untitled product";
      };

      // Pull any image URL exposed in the rescue response payload.
      const rescueImageBySku = new Map<string, string>();
      rescueResults.forEach((result, index) => {
        const sku = skus[index];
        if (!result?.ok || !sku) return;
        const payload = (result as any).data ?? {};
        const candidates = [
          payload?.post_write_db?.image_url,
          payload?.updated_db?.image_url,
          payload?.attempted_write_payload?.image_url,
          payload?.matched_summary_identity?.main_image,
          payload?.matched_summary_identity?.image_url,
          payload?.verification_trace?.matched_summary_identity?.main_image,
          payload?.raw_summary_excerpt?.mainImage?.link,
          payload?.raw_summary_excerpt?.images?.[0]?.link,
          payload?.raw_summary_excerpt?.images?.[0]?.[0]?.link,
        ];
        const resolved = candidates.find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        if (resolved) rescueImageBySku.set(sku, resolved);
      });

      // Amazon serves a standard product image by ASIN; use as last-resort fallback
      // so the dialog never renders a blank thumbnail.
      const amazonImageFallback = (asin: string) =>
        asin && asin.trim().length > 0
          ? `https://images.amazon.com/images/P/${asin.trim()}.01._SCRMZZZZZZ_.jpg`
          : null;

      const resolveDisplayImage = (baseImage: string | null | undefined, sku: string) => {
        if (typeof baseImage === "string" && baseImage.trim().length > 0) return baseImage;
        const listingImage = listingMetaBySku.get(sku)?.imageUrl;
        if (listingImage) return listingImage;
        const rescueImage = rescueImageBySku.get(sku);
        if (rescueImage) return rescueImage;
        return amazonImageFallback(trimmed);
      };

      // Helper: fetch from inventory (with optional retry for eventual consistency).
      const fetchInventoryRows = async () => {
        let invQuery = supabase
          .from("inventory")
          .select("id, asin, sku, title, image_url, available, reserved, inbound")
          .eq("user_id", user.id)
          .eq("asin", trimmed);
        if (userSku) invQuery = invQuery.eq("sku", userSku);
        const { data: rows, error } = await invQuery;
        if (error) throw error;
        return rows ?? [];
      };

      let rows = await fetchInventoryRows();
      // Brief retry if no row yet (insert may still be propagating).
      if (rows.length === 0) {
        await new Promise((r) => setTimeout(r, 800));
        rows = await fetchInventoryRows();
      }

      let mapped: ShipmentItem[] = rows
        .filter((row) => row.asin && row.sku)
        .map((row) => ({
          id: `${row.asin}:${row.sku}`,
          sku: row.sku ?? "",
          asin: row.asin ?? "",
          title: resolveDisplayTitle(row.title, row.sku ?? "", row.asin ?? ""),
          imageUrl: resolveDisplayImage(row.image_url, row.sku ?? ""),
          availableQty: Math.max(0, safeNumber(row.available ?? 0)),
          qtyToShip: 0,
          prepCategory: "NO_PREP" as PrepValue,
          expirationRequired: false,
          expirationDate: "",
          expirationManualOverride: false,
          expirationDetectionReason: null,
        }));

      // Fallback: if DB still has no row, build the item directly from the rescue
      // function's response payload (live_stock + the SKUs we synced). This handles
      // cases where the rescue ran live-API checks but didn't persist (e.g. no
      // created_listing record or suspicious-zero block).
      if (mapped.length === 0) {
        const fromResponse: ShipmentItem[] = [];
        for (let i = 0; i < rescueResults.length; i++) {
          const r = rescueResults[i] as any;
          const sku = skus[i];
          if (!r?.ok) continue;
          const payload = r.data || {};
          const live = payload.live_stock || payload.updated_db || payload.post_write_db || {};
          const available = Math.max(0, safeNumber(live.available ?? 0));
          fromResponse.push({
            id: `${trimmed}:${sku}`,
            sku,
            asin: trimmed,
            title: resolveDisplayTitle(null, sku, trimmed),
            imageUrl: resolveDisplayImage(null, sku),
            availableQty: available,
            qtyToShip: 0,
            prepCategory: "NO_PREP" as PrepValue,
            expirationRequired: false,
            expirationDate: "",
            expirationManualOverride: false,
            expirationDetectionReason: null,
          });
        }
        mapped = fromResponse;
      }

      if (mapped.length === 0) {
        setAsinSyncResult({
          ok: false,
          message:
            "ASIN synced but no inventory row was created. The listing may not exist in your Product Library yet — add it there first, then retry.",
        });
        toast.warning("Synced, but no inventory row available");
        return;
      }

      // Merge into the draft so it shows up in Step 2 immediately.
      setDraft((current) => ({
        ...current,
        items: hydrateDraftItems(mapped, current.items),
      }));
      // Also seed the search box so the row is visible in the table.
      setSearch(trimmed);

      const first = mapped[0];
      setAsinSyncResult({
        ok: true,
        asin: first.asin,
        sku: first.sku,
        title: first.title,
        imageUrl: first.imageUrl,
        available: first.availableQty,
      });
      toast.success(`Synced ${trimmed} — added to shipment list`);
    } catch (err: any) {
      const message = err?.message || "Sync failed";
      setAsinSyncResult({ ok: false, message });
      toast.error(`ASIN sync failed: ${message}`);
    } finally {
      setAsinSyncBusy(false);
    }
  };

  const removeItemFromShipment = (itemId: string) => {
    lastLocalDraftChangeAtRef.current = Date.now();
    setDraft((current) => {
      const target = current.items.find((item) => item.id === itemId);
      if (!target) return current;
      const nextBoxQuantities = { ...current.boxQuantities };
      delete nextBoxQuantities[itemId];
      return {
        ...current,
        items: current.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                qtyToShip: 0,
                addedToShipment: false,
                savedToShipment: false,
                expirationRequired: false,
                expirationDate: "",
              }
            : item,
        ),
        boxQuantities: nextBoxQuantities,
        packedKeys: current.packedKeys.filter((key) => !key.startsWith(`${itemId}-`)),
      };
    });
    setSelectedComplianceItemIds((current) => current.filter((id) => id !== itemId));
    toast.success("Item removed from shipment");
  };

  const updatePrepCategory = (itemId: string, prepCategory: PrepValue) => {
    updateItem(itemId, (item) => ({ ...item, prepCategory }));
  };

  const updateExpirationRequirement = (itemId: string, expirationRequired: boolean) => {
    updateItem(itemId, (item) => ({
      ...item,
      expirationRequired,
      expirationManualOverride: true,
      expirationDate: expirationRequired ? item.expirationDate : "",
    }));
  };

  const updateExpirationDate = (itemId: string, expirationDate: string) => {
    updateItem(itemId, (item) => ({ ...item, expirationDate }));
  };

  const detectExpirationRequirements = async () => {
    const candidates = selectedItems.filter((item) => !item.expirationManualOverride && item.asin);
    if (candidates.length === 0) return;

    setExpirationDetectionLoading(true);
    const { data, error } = await supabase.functions.invoke("detect-expiration-requirements", {
      body: {
        items: candidates.map((item) => ({ asin: item.asin, sku: item.sku })),
      },
    });

    if (!error && data?.items) {
      const detectedByAsin = new Map(
        (data.items as Array<{ asin: string; expirationRequired: boolean; detectionReason: string | null }>).map((item) => [item.asin, item]),
      );

      setDraft((current) => ({
        ...current,
        items: current.items.map((item) => {
          const detected = detectedByAsin.get(item.asin);
          if (!detected || item.expirationManualOverride) return item;
          return {
            ...item,
            expirationRequired: detected.expirationRequired,
            expirationDetectionReason: detected.detectionReason,
            expirationDate: detected.expirationRequired ? item.expirationDate : "",
          };
        }),
      }));
    }

    setExpirationDetectionLoading(false);
  };

  const setCurrentStep = (step: StepId) => {
    setDraft((current) => ({ ...current, step }));
  };

  const updateBoxQuantity = (itemId: string, boxIndex: number, value: string) => {
    const qty = Math.max(0, Math.floor(safeNumber(value)));
    setDraft((current) => {
      const next = { ...current.boxQuantities };
      const existing = Array.from({ length: current.numberOfBoxes }, (_, index) => next[itemId]?.[index] ?? 0);
      if (current.identicalBoxes) {
        next[itemId] = Array.from({ length: current.numberOfBoxes }, () => qty);
      } else {
        existing[boxIndex] = qty;
        next[itemId] = existing;
      }
      return { ...current, boxQuantities: next };
    });
  };

  const updateSameDimension = (field: keyof BoxDimension, value: string) => {
    setDraft((current) => {
      const nextSameDimensions = {
        ...current.sameDimensions,
        [field]: field === "unit" ? value : safeNumber(value),
      } as BoxDimension;

      return {
        ...current,
        sameDimensions: nextSameDimensions,
        boxDimensions: cloneAllBoxDimensions(current.numberOfBoxes, nextSameDimensions),
      };
    });
  };

  const updateBoxDimension = (boxIndex: number, field: keyof BoxDimension, value: string) => {
    setDraft((current) => {
      const nextDimension = {
        ...(current.boxDimensions[boxIndex] ?? createEmptyDimension()),
        [field]: field === "unit" ? value : safeNumber(value),
      } as BoxDimension;

      const nextBoxDimensions = current.identicalBoxes && boxIndex === 0
        ? cloneAllBoxDimensions(current.numberOfBoxes, nextDimension)
        : current.boxDimensions.map((dimension, index) =>
            index === boxIndex ? nextDimension : dimension,
          );

      return {
        ...current,
        boxDimensions: nextBoxDimensions,
        sameDimensions: current.identicalBoxes && boxIndex === 0 ? nextDimension : current.sameDimensions,
      };
    });
  };

  const updateSameWeight = (field: keyof BoxWeight, value: string) => {
    setDraft((current) => {
      const nextSameWeight = {
        ...current.sameWeight,
        [field]: field === "unit" ? value : safeNumber(value),
      } as BoxWeight;

      return {
        ...current,
        sameWeight: nextSameWeight,
        boxWeights: cloneAllBoxWeights(current.numberOfBoxes, nextSameWeight),
      };
    });
  };

  const updateBoxWeight = (boxIndex: number, field: keyof BoxWeight, value: string) => {
    setDraft((current) => {
      const nextWeight = {
        ...(current.boxWeights[boxIndex] ?? createEmptyWeight()),
        [field]: field === "unit" ? value : safeNumber(value),
      } as BoxWeight;

      const nextBoxWeights = current.identicalBoxes && boxIndex === 0
        ? cloneAllBoxWeights(current.numberOfBoxes, nextWeight)
        : current.boxWeights.map((weight, index) =>
            index === boxIndex ? nextWeight : weight,
          );

      return {
        ...current,
        boxWeights: nextBoxWeights,
        sameWeight: current.identicalBoxes && boxIndex === 0 ? nextWeight : current.sameWeight,
      };
    });
  };

  const validateStep2 = () => {
    if (unsavedShipmentItems.length > 0) {
      toast.error("Press Save on every product before continuing");
      return false;
    }
    if (selectedItems.length === 0) {
      toast.error("Select at least one product to continue");
      return false;
    }
    return true;
  };

  const validateStep3 = () => {
    if (selectedItems.length === 0) {
      toast.error("Select at least one product first");
      return false;
    }

    const hasZeroQty = selectedItems.some((item) => item.qtyToShip <= 0);
    if (hasZeroQty) {
      toast.error("Every selected product needs a quantity greater than 0");
      return false;
    }

    const missingExpiration = selectedItems.some(
      (item) => item.expirationRequired && !item.expirationDate,
    );
    if (missingExpiration) {
      toast.error("Add every required expiration date before continuing");
      return false;
    }

    return true;
  };

  const validateStep4 = () => {
    if (draft.numberOfBoxes <= 0) {
      toast.error("Enter a valid number of boxes");
      return false;
    }

    const invalid = selectedItems.find((item) => {
      const quantities = getBoxArray(item.id);
      if (draft.identicalBoxes) {
        const perBox = quantities[0] ?? 0;
        return perBox * draft.numberOfBoxes !== item.qtyToShip;
      }
      const total = quantities.reduce((sum, qty) => sum + qty, 0);
      return total !== item.qtyToShip;
    });

    if (invalid) {
      toast.error(`Box quantities must match the shipment total for ${invalid.sku}`);
      return false;
    }

    return true;
  };

  const validateBoxDimension = (dimension: BoxDimension) =>
    dimension.length > 0 && dimension.width > 0 && dimension.height > 0;

  const validateBoxWeight = (weight: BoxWeight) => weight.weight > 0;

  const invalidDimensionBoxes = draft.applySameDimensions
    ? (validateBoxDimension(draft.sameDimensions) ? [] : ["All boxes"])
    : draft.boxDimensions
        .map((dimension, index) => ({ index, valid: validateBoxDimension(dimension) }))
        .filter((box) => !box.valid)
        .map((box) => `Box ${box.index + 1}`);
  const invalidWeightBoxes = draft.allowPerBoxWeight
    ? draft.boxWeights
        .map((weight, index) => ({ index, valid: validateBoxWeight(weight) }))
        .filter((box) => !box.valid)
        .map((box) => `Box ${box.index + 1}`)
    : (validateBoxWeight(draft.sameWeight) ? [] : ["All boxes"]);
  const canContinueFromDimensions = invalidDimensionBoxes.length === 0 && invalidWeightBoxes.length === 0;

  const validateStep5 = () => {
    const dimensionsValid = draft.applySameDimensions
      ? validateBoxDimension(draft.sameDimensions)
      : draft.boxDimensions.every(validateBoxDimension);

    if (!dimensionsValid) {
      toast.error("Complete all box dimensions before continuing");
      return false;
    }

    const weightsValid = draft.allowPerBoxWeight
      ? draft.boxWeights.every(validateBoxWeight)
      : validateBoxWeight(draft.sameWeight);

    if (!weightsValid) {
      toast.error("Complete all box weights before continuing");
      return false;
    }

    return true;
  };

    const nextFromProducts = async () => {
    if (!validateStep2()) return;
    await detectExpirationRequirements();
    // Step 3 (Quantities & Compliance) is skipped — initialize box arrays and jump straight to Step 4.
    selectedItems.forEach((item) => {
      const existing = draft.boxQuantities[item.id];
      if (!existing || existing.length !== draft.numberOfBoxes) {
        setDraft((current) => ({
          ...current,
          boxQuantities: {
            ...current.boxQuantities,
            [item.id]: Array.from({ length: current.numberOfBoxes }, () => 0),
          },
        }));
      }
    });
    setSearch("");
    setSearchQuery("");
    setCurrentStep(4);
  };

  const nextFromCompliance = () => {
    if (!validateStep3()) return;
    selectedItems.forEach((item) => {
      const existing = draft.boxQuantities[item.id];
      if (!existing || existing.length !== draft.numberOfBoxes) {
        setDraft((current) => ({
          ...current,
          boxQuantities: {
            ...current.boxQuantities,
            [item.id]: Array.from({ length: current.numberOfBoxes }, () => 0),
          },
        }));
      }
    });
    setCurrentStep(4);
  };

  const nextFromBoxes = () => {
    if (!validateStep4()) return;
    // Skip step 5 (Dimensions & Weight) — values are hardcoded defaults; jump to step 6.
    nextFromDimensions();
  };

  const nextFromDimensions = () => {
    // Step 5 is display-only with hardcoded defaults — finalized in Amazon's Send-to-Amazon flow.
    // Backfill any empty dimensions/weights with the displayed defaults so downstream validation passes.
    setDraft((current) => {
      const fillDim = (d: BoxDimension): BoxDimension => ({
        length: d.length > 0 ? d.length : 18,
        width: d.width > 0 ? d.width : 14,
        height: d.height > 0 ? d.height : 12,
        unit: d.unit || "in",
      });
      const fillWeight = (w: BoxWeight): BoxWeight => ({
        weight: w.weight > 0 ? w.weight : 25,
        unit: w.unit || "lb",
      });
      return {
        ...current,
        sameDimensions: fillDim(current.sameDimensions),
        boxDimensions: current.boxDimensions.map(fillDim),
        sameWeight: fillWeight(current.sameWeight),
        boxWeights: current.boxWeights.map(fillWeight),
      };
    });
    setCurrentStep(6);
  };

  const validationChecklist = useMemo(() => {
    const quantitiesValid = selectedItems.length > 0 && selectedItems.every((item) => item.qtyToShip > 0);
    const complianceValid =
      quantitiesValid && selectedItems.every((item) => !item.expirationRequired || Boolean(item.expirationDate));
    const boxesValid =
      selectedItems.length > 0 &&
      selectedItems.every((item) => {
        const quantities = getBoxArray(item.id);
        return draft.identicalBoxes
          ? (quantities[0] ?? 0) * draft.numberOfBoxes === item.qtyToShip
          : quantities.reduce((sum, qty) => sum + qty, 0) === item.qtyToShip;
      });
    const dimensionsComplete = draft.applySameDimensions
      ? validateBoxDimension(draft.sameDimensions)
      : draft.boxDimensions.every(validateBoxDimension);
    const weightsComplete = draft.allowPerBoxWeight
      ? draft.boxWeights.every(validateBoxWeight)
      : validateBoxWeight(draft.sameWeight);
    const noMissingData =
      draft.creationMode === "quantity-only"
        ? complianceValid
        : complianceValid && boxesValid && dimensionsComplete && weightsComplete;

    return {
      quantitiesValid,
      complianceValid,
      boxesValid,
      dimensionsComplete: dimensionsComplete && weightsComplete,
      noMissingData,
    };
  }, [selectedItems, draft]);

  const handleDownloadCsv = () => {
    const rows = exportRowsFromDraft(draft);
    if (!rows.length) {
      toast.error("Nothing to export yet");
      return;
    }

    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => row[header as keyof typeof row]).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.shipmentName || "shipment-plan"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  const handleDownloadExcel = () => {
    const rows = exportRowsFromDraft(draft);
    if (!rows.length) {
      toast.error("Nothing to export yet");
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Shipment Plan");
    XLSX.writeFile(workbook, `${draft.shipmentName || "shipment-plan"}.xlsx`);
    toast.success("Excel file downloaded");
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(buildCopySummary(draft));
      toast.success("Summary copied");
    } catch {
      toast.error("Could not copy summary");
    }
  };

  const handleCopyAmazonDebugDetails = async () => {
    try {
      await navigator.clipboard.writeText(buildAmazonDebugDetails(draft));
      toast.success("Amazon debug details copied");
    } catch {
      toast.error("Could not copy Amazon debug details");
    }
  };

  const handleCopyInboundPlanId = async () => {
    const id = (draft.inboundPlanId ?? "").trim();
    if (!id) {
      toast.error("No inbound plan ID to copy yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Inbound Plan ID copied", { description: id });
    } catch {
      toast.error("Could not copy Inbound Plan ID");
    }
  };

  const handleCheckPlanStatus = async () => {
    const id = (draft.inboundPlanId ?? "").trim();
    if (!id) {
      toast.error("No inbound plan ID yet");
      return;
    }
    setCheckPlanStatusBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("check-inbound-plan-status", {
        body: { inboundPlanId: id },
      });
      const fetchedAt = new Date().toISOString();
      if (error) {
        setPlanStatusDialog({
          open: true,
          inboundPlanId: id,
          status: "ERROR",
          shipmentIds: [],
          shipmentsCount: 0,
          destinationMarketplaces: [],
          sourceAddress: null,
          fetchedAt,
          error: error.message ?? "Amazon did not respond.",
        });
        return;
      }
      const status = (data?.status as string) ?? "UNKNOWN";
      const shipmentIds: string[] = Array.isArray(data?.shipmentIds) ? data.shipmentIds : [];
      const shipmentsCount = typeof data?.shipmentsCount === "number" ? data.shipmentsCount : shipmentIds.length;
      const destinationMarketplaces = Array.isArray(data?.destinationMarketplaces) ? data.destinationMarketplaces : [];
      const sourceAddress = data?.sourceAddress ?? null;

      const operationErrors = Array.isArray(data?.operationErrors) ? data.operationErrors : [];
      const isErrored = status === "ERRORED" || data?.success === false;
      const statusExpirationContext = extractExpirationContextFromPayload(data);
      const errorMessage = isErrored
        ? (data?.error ?? (operationErrors.length > 0
            ? operationErrors.flatMap((e: any) => e.messages || []).slice(0, 3).join(" | ")
            : "Amazon rejected the plan but did not return a reason."))
        : undefined;

      setPlanStatusDialog({
        open: true,
        inboundPlanId: id,
        status,
        shipmentIds,
        shipmentsCount,
        destinationMarketplaces,
        sourceAddress,
        fetchedAt,
        error: errorMessage,
        httpStatus: typeof data?.httpStatus === "number" ? data.httpStatus : undefined,
        operationErrors,
      });

      const nowIso = new Date().toISOString();
      // Persist any shipment IDs Amazon now reports so the dashboard reflects reality.
      // If Amazon says the plan ERRORED, fully reset the Amazon-created state so the
      // user can recreate the shipment from this draft instead of being stuck with
      // a dead inbound plan that still makes the UI look resumable.
      if (isErrored && draft.status !== "synced" && draft.status !== "completed" && draft.status !== "archived") {
        const reverted: ShipmentDraftState = {
          ...draft,
          status: "draft",
          inboundPlanId: undefined,
          shipmentId: undefined,
          shipmentIds: undefined,
          placementOptionId: undefined,
          amazonShipmentCreatedAt: undefined,
          continuedToAmazonAt: undefined,
          amazonOperationId: undefined,
          amazonPlanStatus: "ERRORED",
          amazonPlanStatusCheckedAt: nowIso,
          amazonWorkflowMessage: errorMessage ?? "Amazon rejected this inbound plan.",
          amazonStepDiagnostics: statusExpirationContext
            ? normalizeAmazonDiagnostics([
                ...(draft.amazonStepDiagnostics ?? []),
                {
                  step: "createInboundPlan",
                  endpoint: "/inbound/fba/2024-03-20/inboundPlans",
                  success: false,
                  status: "failed",
                  code: statusExpirationContext.code,
                  message: statusExpirationContext.message ?? errorMessage ?? "Amazon requires an expiration date.",
                  expirationContext: statusExpirationContext,
                },
              ])
            : draft.amazonStepDiagnostics,
          syncStatusNote: "Amazon rejected this inbound plan. Fix the issue and recreate the shipment.",
          updatedAt: nowIso,
        };
        setDraft(reverted);
        setShipmentLibrary((current) => upsertShipmentRecord(current, reverted, user?.id));
      } else {
        const updated: ShipmentDraftState = {
          ...draft,
          shipmentId: draft.shipmentId ?? shipmentIds[0],
          shipmentIds: shipmentIds.length > 0 ? shipmentIds : draft.shipmentIds,
          amazonPlanStatus: status,
          amazonPlanStatusCheckedAt: nowIso,
          updatedAt: nowIso,
        };
        setDraft(updated);
        setShipmentLibrary((current) => upsertShipmentRecord(current, updated, user?.id));
        setWorkspaceSection("continued");
      }
    } catch (err) {
      setPlanStatusDialog({
        open: true,
        inboundPlanId: id,
        status: "ERROR",
        shipmentIds: [],
        shipmentsCount: 0,
        destinationMarketplaces: [],
        sourceAddress: null,
        fetchedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : "Unexpected error",
      });
    } finally {
      setCheckPlanStatusBusy(false);
    }
  };

  const handleContinueInAmazon = () => {
    const isQuantityOnly = draft.creationMode === "quantity-only";
    const targetUrl = draft.shipmentId
      ? AMAZON_SELLER_CENTRAL_URL
      : buildSendToAmazonUrl(draft.inboundPlanId);
    window.open(targetUrl, "_blank", "noopener,noreferrer");
    toast(
      draft.shipmentId
        ? "Amazon Seller Central opened"
        : "Send to Amazon workflow opened",
      {
        description: draft.shipmentId
          ? `Shipment ${draft.shipmentId} is ready for final review in Amazon.`
          : draft.inboundPlanId
            ? isQuantityOnly
              ? `Inbound plan ${draft.inboundPlanId} is loaded. Finish placement, boxes, weights and confirmation in Seller Central — no shipment exists yet.`
              : `Inbound plan ${draft.inboundPlanId} is ready for you to finish in Amazon.`
            : "Open Amazon Seller Central to continue the shipment.",
      },
    );

    // Mark this shipment as "Continued to Amazon" so the dashboard reflects
    // the user's actual workflow (Create Qty -> Continue to Amazon).
    // Don't downgrade an already-synced/completed shipment.
    if (draft.status === "synced" || draft.status === "completed" || draft.status === "archived") return;

    const nowIso = new Date().toISOString();
    const updated: ShipmentDraftState = {
      ...draft,
      status: "continued",
      continuedToAmazonAt: draft.continuedToAmazonAt ?? nowIso,
      updatedAt: nowIso,
    };
    setDraft(updated);
    setShipmentLibrary((current) => upsertShipmentRecord(current, updated, user?.id));
  };

  const buildShipmentPayload = () => {
    const products = selectedItems.map((item) => ({
      sku: item.sku,
      asin: item.asin,
      title: item.title,
      quantity: item.qtyToShip,
      expirationDate: item.expirationRequired ? item.expirationDate || null : null,
      prepCategory: item.prepCategory === "NO_PREP" ? "NONE" : item.prepCategory,
    }));

    if (draft.creationMode === "quantity-only") {
      return {
        shipmentId: draft.shipmentId || draft.id,
        shipmentName: draft.shipmentName,
        numberOfBoxes: 0,
        boxDimensions: {
          length: 0,
          width: 0,
          height: 0,
          dimensionUnit: "in" as const,
        },
        boxes: [],
        products,
      };
    }

    const defaultDimension = draft.applySameDimensions ? draft.sameDimensions : createEmptyDimension();
    const defaultWeight = draft.allowPerBoxWeight ? createEmptyWeight() : draft.sameWeight;

    const boxes = Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => ({
      boxIndex: boxIndex + 1,
      items: selectedItems
        .map((item) => ({
          productId: item.id,
          sku: item.sku,
          quantityInThisBox: draft.identicalBoxes
            ? draft.boxQuantities[item.id]?.[0] ?? 0
            : draft.boxQuantities[item.id]?.[boxIndex] ?? 0,
        }))
        .filter((entry) => entry.quantityInThisBox > 0),
      weight: draft.allowPerBoxWeight
        ? draft.boxWeights[boxIndex]?.weight ?? 0
        : defaultWeight.weight,
      weightUnit: draft.allowPerBoxWeight
        ? draft.boxWeights[boxIndex]?.unit ?? "lb"
        : defaultWeight.unit,
      dimensions: draft.applySameDimensions
        ? defaultDimension
        : draft.boxDimensions[boxIndex] ?? createEmptyDimension(),
    }));

    return {
      shipmentId: draft.shipmentId || draft.id,
      shipmentName: draft.shipmentName,
      numberOfBoxes: draft.numberOfBoxes,
      boxDimensions: {
        length: draft.sameDimensions.length,
        width: draft.sameDimensions.width,
        height: draft.sameDimensions.height,
        dimensionUnit: draft.sameDimensions.unit,
      },
      boxes,
      products,
    };
  };

  const createShipmentInAmazon = async () => {
    if (!draft.shipmentName.trim()) {
      toast.error("Shipment name is required");
      return;
    }

    if (!validationChecklist.noMissingData) {
      toast.error(
        draft.creationMode === "quantity-only"
          ? "Finish the quantities and compliance details before creating it in Amazon"
          : "Finish the shipment details before creating it in Amazon",
      );
      return;
    }

    setShipmentSubmitting(true);
    setDraft((current) => ({
      ...current,
      inboundPlanId: undefined,
      shipmentId: undefined,
      shipmentIds: undefined,
      placementOptionId: undefined,
      amazonShipmentCreatedAt: undefined,
      amazonWriteAccessCode: undefined,
      amazonWriteAccessMessage: undefined,
      amazonWorkflowMessage: undefined,
      amazonStepDiagnostics: undefined,
      amazonOperationId: undefined,
      amazonPlanStatus: undefined,
      amazonPlanStatusCheckedAt: undefined,
      syncStatusNote: undefined,
    }));

    let latestStepDiagnostics: AmazonStepDiagnostic[] = [];

    try {
      const payload = buildShipmentPayload();
      const stepDiagnostics: AmazonStepDiagnostic[] = [];

      const { data: inboundData, error: inboundError } = await supabase.functions.invoke("create-inbound-plan", {
        body: payload,
      });

      const inboundPayload = await getEdgeFunctionPayload(
        inboundError,
        inboundData as Record<string, unknown> | undefined,
      );
      const inboundDiagnostics = Array.isArray(inboundPayload?.stepResults)
        ? (inboundPayload.stepResults as AmazonStepDiagnostic[])
            .map((step) => ({ ...step, status: step.status ?? (step.success ? "success" : "failed") }))
        : [];
      stepDiagnostics.push(
        ...inboundDiagnostics,
      );
      latestStepDiagnostics = [...stepDiagnostics];

      if (inboundError || !inboundData?.inboundPlanId) {
        const inboundCode = getEdgeFunctionCode(inboundPayload);
        if (inboundCode === AMAZON_INBOUND_WRITE_ACCESS_CODE) {
          const normalizedStepDiagnostics = normalizeAmazonDiagnostics(stepDiagnostics);
          const amazonBlockedDraft = {
            ...draft,
            amazonWriteAccessCode: inboundCode,
            amazonWriteAccessMessage: AMAZON_INBOUND_WRITE_ACCESS_BANNER,
            amazonWorkflowMessage: undefined,
            amazonStepDiagnostics: normalizedStepDiagnostics,
            syncStatusNote: AMAZON_INBOUND_WRITE_ACCESS_FALLBACK,
            updatedAt: new Date().toISOString(),
          };

          setDraft(amazonBlockedDraft);
          setShipmentLibrary((current) => upsertShipmentRecord(current, amazonBlockedDraft, user?.id));
        }

        throw new Error(
          getEdgeFunctionMessage(inboundError, inboundPayload, "Could not create the inbound plan"),
        );
      }

      const inboundPlanId = String(inboundData.inboundPlanId);
      const isQuantityOnly = draft.creationMode === "quantity-only";
      const normalizedInboundDiagnostics = normalizeAmazonDiagnostics(stepDiagnostics);
      const initialOperationId =
        typeof (inboundData as Record<string, unknown>)?.operationId === "string"
          ? String((inboundData as Record<string, unknown>).operationId)
          : undefined;
      const initialOpStatus = String((inboundData as Record<string, unknown>)?.operationStatus ?? "IN_PROGRESS");
      // HTTP 202 only means "accepted for processing". Until Amazon confirms
      // ACTIVE/WORKING the plan is NOT usable. Mark as PROCESSING so the UI
      // shows "Amazon is processing…" instead of "Inbound Plan Created".
      const initialPlanStatus =
        initialOpStatus === "SUCCESS" ? "PROCESSING" : "PROCESSING";
      const nowIso = new Date().toISOString();

      // Persist the inbound plan + processing state immediately so the user
      // can always recover (and we never lose the operationId for polling).
      setDraft((current) => ({
        ...current,
        inboundPlanId,
        amazonOperationId: initialOperationId,
        amazonPlanStatus: initialPlanStatus,
        amazonPlanStatusCheckedAt: nowIso,
        amazonStepDiagnostics: normalizedInboundDiagnostics,
        amazonShipmentCreatedAt: current.amazonShipmentCreatedAt ?? nowIso,
        syncStatusNote: "Amazon is processing the inbound plan… this usually takes 5–30 seconds.",
        updatedAt: nowIso,
      }));
      setShipmentLibrary((current) => {
        const currentEntry = current.find((entry) => entry.id === draft.id) ?? draft;
        return upsertShipmentRecord(current, {
          ...currentEntry,
          inboundPlanId,
          amazonOperationId: initialOperationId,
          amazonPlanStatus: initialPlanStatus,
          amazonPlanStatusCheckedAt: nowIso,
          amazonStepDiagnostics: normalizedInboundDiagnostics,
          amazonShipmentCreatedAt: currentEntry.amazonShipmentCreatedAt ?? nowIso,
          syncStatusNote: "Amazon is processing the inbound plan… this usually takes 5–30 seconds.",
          updatedAt: nowIso,
        }, user?.id);
      });

      if (isQuantityOnly) {
        toast.loading("Amazon is processing the inbound plan…", {
          id: `inbound-poll-${inboundPlanId}`,
          description: "Waiting for Amazon to confirm the plan is active.",
        });

        // Auto-poll the plan status until terminal. We do NOT mark this draft
        // as a successful synced/usable plan until Amazon returns ACTIVE/WORKING.
        // If Amazon returns ERRORED we revert and show the failure.
        let finalStatus = "PROCESSING";
        let finalError: string | undefined;
        let finalExpirationContext: AmazonExpirationContext | null = null;
        let finalShipmentIds: string[] = [];
        const TERMINAL_OK = new Set(["ACTIVE", "WORKING", "SHIPPED", "RECEIVING", "CLOSED"]);
        const POLL_DEADLINE = Date.now() + 60_000;
        let delay = 4000;
        while (Date.now() < POLL_DEADLINE) {
          await new Promise((r) => setTimeout(r, delay));
          try {
            const { data: statusData, error: statusError } = await supabase.functions.invoke(
              "check-inbound-plan-status",
              { body: { inboundPlanId } },
            );
            if (statusError) {
              console.warn("[ShipmentBuilder] poll error:", statusError);
              delay = Math.min(delay + 1000, 8000);
              continue;
            }
            const polledStatus = String(statusData?.status ?? "UNKNOWN");
            const polledShipmentIds: string[] = Array.isArray(statusData?.shipmentIds) ? statusData.shipmentIds : [];
            const checkedAt = new Date().toISOString();
            setDraft((current) => current.id === draft.id ? {
              ...current,
              amazonPlanStatus: polledStatus,
              amazonPlanStatusCheckedAt: checkedAt,
              shipmentIds: polledShipmentIds.length > 0 ? polledShipmentIds : current.shipmentIds,
              shipmentId: current.shipmentId ?? polledShipmentIds[0],
              updatedAt: checkedAt,
            } : current);
            if (polledStatus === "ERRORED" || statusData?.success === false) {
              finalStatus = "ERRORED";
              finalError = String(statusData?.error ?? "Amazon rejected the inbound plan after accepting the request.");
              finalExpirationContext = extractExpirationContextFromPayload(statusData);
              break;
            }
            if (TERMINAL_OK.has(polledStatus)) {
              finalStatus = polledStatus;
              finalShipmentIds = polledShipmentIds;
              break;
            }
          } catch (pollErr) {
            console.warn("[ShipmentBuilder] poll exception:", pollErr);
          }
          delay = Math.min(delay + 1000, 8000);
        }

        toast.dismiss(`inbound-poll-${inboundPlanId}`);

        if (finalStatus === "ERRORED") {
          // Plan failed during Amazon-side processing. Revert so the user can
          // recreate the shipment instead of being stuck with a dead plan.
          const failedAt = new Date().toISOString();
          setDraft((current) => current.id === draft.id ? {
            ...current,
            status: "draft",
            inboundPlanId: undefined,
            shipmentId: undefined,
            shipmentIds: undefined,
            placementOptionId: undefined,
            amazonShipmentCreatedAt: undefined,
            continuedToAmazonAt: undefined,
            amazonOperationId: undefined,
            amazonPlanStatus: "ERRORED",
            amazonPlanStatusCheckedAt: failedAt,
            amazonWorkflowMessage: finalError ?? "Amazon rejected this inbound plan.",
            amazonStepDiagnostics: finalExpirationContext
              ? normalizedInboundDiagnostics.map((step) =>
                  step.step === "createInboundPlan"
                    ? { ...step, success: false, status: "failed", code: finalExpirationContext?.code, message: finalExpirationContext?.message ?? step.message, expirationContext: finalExpirationContext }
                    : step,
                )
              : current.amazonStepDiagnostics,
            syncStatusNote: "Amazon rejected this inbound plan. Fix the issue and recreate the shipment.",
            updatedAt: failedAt,
          } : current);
          setShipmentLibrary((current) => {
            const entry = current.find((e) => e.id === draft.id);
            if (!entry) return current;
            return upsertShipmentRecord(current, {
              ...entry,
              status: "draft",
              inboundPlanId: undefined,
              shipmentId: undefined,
              shipmentIds: undefined,
              placementOptionId: undefined,
              amazonShipmentCreatedAt: undefined,
              continuedToAmazonAt: undefined,
              amazonOperationId: undefined,
              amazonPlanStatus: "ERRORED",
              amazonPlanStatusCheckedAt: failedAt,
              amazonWorkflowMessage: finalError ?? "Amazon rejected this inbound plan.",
              amazonStepDiagnostics: finalExpirationContext
                ? normalizedInboundDiagnostics.map((step) =>
                    step.step === "createInboundPlan"
                      ? { ...step, success: false, status: "failed", code: finalExpirationContext?.code, message: finalExpirationContext?.message ?? step.message, expirationContext: finalExpirationContext }
                      : step,
                  )
                : entry.amazonStepDiagnostics,
              syncStatusNote: "Amazon rejected this inbound plan. Fix the issue and recreate the shipment.",
              updatedAt: failedAt,
            }, user?.id);
          });
          toast.error("Inbound plan failed", {
            description: finalError ?? "Amazon marked the plan as ERRORED. The draft was reset so you can recreate it.",
          });
          return;
        }

        if (TERMINAL_OK.has(finalStatus)) {
          const result: AmazonShipmentResult = {
            inboundPlanId,
            shipmentId: finalShipmentIds[0] ?? null,
            shipmentIds: finalShipmentIds,
            placementOptionId: undefined,
            createdAt: new Date().toISOString(),
          };
          setDraft((current) => ({
            ...current,
            status: current.status === "synced" || current.status === "completed" || current.status === "archived" ? current.status : "continued",
            continuedToAmazonAt: current.continuedToAmazonAt ?? result.createdAt,
            inboundPlanId: result.inboundPlanId,
            shipmentIds: result.shipmentIds.length > 0 ? result.shipmentIds : current.shipmentIds,
            shipmentId: current.shipmentId ?? result.shipmentId ?? undefined,
            amazonShipmentCreatedAt: result.createdAt,
            amazonPlanStatus: finalStatus,
            amazonPlanStatusCheckedAt: result.createdAt,
            amazonWorkflowMessage: undefined,
            amazonStepDiagnostics: normalizedInboundDiagnostics,
            syncStatusNote: "Inbound plan is active in Amazon — open Seller Central to finish placement, boxes, weights, and create the actual shipment.",
            updatedAt: result.createdAt,
          }));
          setShipmentLibrary((current) => {
            const entry = current.find((e) => e.id === draft.id) ?? draft;
            return upsertShipmentRecord(current, {
              ...entry,
              status: entry.status === "synced" || entry.status === "completed" || entry.status === "archived" ? entry.status : "continued",
              continuedToAmazonAt: entry.continuedToAmazonAt ?? result.createdAt,
              inboundPlanId: result.inboundPlanId,
              shipmentIds: result.shipmentIds.length > 0 ? result.shipmentIds : entry.shipmentIds,
              shipmentId: entry.shipmentId ?? result.shipmentId ?? undefined,
              amazonShipmentCreatedAt: result.createdAt,
              amazonPlanStatus: finalStatus,
              amazonPlanStatusCheckedAt: result.createdAt,
              amazonWorkflowMessage: undefined,
              amazonStepDiagnostics: normalizedInboundDiagnostics,
              syncStatusNote: "Inbound plan is active in Amazon — open Seller Central to finish placement, boxes, weights, and create the actual shipment.",
              updatedAt: result.createdAt,
            }, user?.id);
          });
          setFocusedShipmentId(draft.id);
          setWorkspaceSection("continued");
          toast.success("Inbound Plan Ready", {
            description: "Amazon confirmed the plan is active and usable. Open Seller Central to finish placement, boxes, weights and create the actual shipment.",
          });
          return;
        }

        // Polling timed out without a terminal status. Keep PROCESSING; the
        // user can use "Check Plan Status" to resume polling manually.
        toast("Amazon is still processing", {
          description: "We'll keep the plan as Processing. Use 'Check Plan Status' in a moment to confirm it's ready before continuing in Seller Central.",
        });
        return;
      }

      const { data: placementData, error: placementError } = await supabase.functions.invoke("list-placement-options", {
        body: { inboundPlanId },
      });
      const placementPayload = await getEdgeFunctionPayload(
        placementError,
        placementData as Record<string, unknown> | undefined,
      );
      const placementDiagnostics = Array.isArray(placementPayload?.stepResults)
        ? (placementPayload.stepResults as AmazonStepDiagnostic[])
            .map((step) => ({ ...step, status: step.status ?? (step.success ? "success" : "failed") }))
        : [];
      stepDiagnostics.push(...placementDiagnostics);
      latestStepDiagnostics = [...stepDiagnostics];

      if (placementError || !placementData?.success) {
        const placementCode = getEdgeFunctionCode(placementPayload);

        if (placementCode === AMAZON_INBOUND_WRITE_ACCESS_CODE) {
          const normalizedStepDiagnostics = normalizeAmazonDiagnostics(stepDiagnostics);
          const workflowDraft = {
            ...draft,
            inboundPlanId,
            amazonWriteAccessCode: undefined,
            amazonWriteAccessMessage: undefined,
            amazonWorkflowMessage:
              "Amazon created the inbound plan, but the automated handoff could not continue through placement confirmation for this account/app.",
            amazonStepDiagnostics: normalizedStepDiagnostics,
            syncStatusNote:
              "Inbound plan created. Continue in Seller Central, or retry after Amazon API permissions/workflow access are confirmed.",
            updatedAt: new Date().toISOString(),
          };

          setDraft(workflowDraft);
          setShipmentLibrary((current) => upsertShipmentRecord(current, workflowDraft, user?.id));

          throw new Error(
            getEdgeFunctionMessage(
              placementError,
              placementPayload,
              "Amazon created the inbound plan, but the automated handoff could not continue.",
            ),
          );
        }

        const placementDetails = getEdgeFunctionDetailsText(placementPayload);
        if (placementCode === "INBOUND_PLAN_ERRORED") {
          throw new Error(
            placementDetails
              ? `Amazon rejected the inbound plan after accepting the request. ${placementDetails}`
              : "Amazon rejected the inbound plan after accepting the request, so no shipment was created in Seller Central.",
          );
        }

        throw new Error(
          getEdgeFunctionMessage(
            placementError,
            placementPayload,
            "Could not load Amazon placement options",
          ),
        );
      }

      const placementOptions = Array.isArray(placementData.placementOptions) ? placementData.placementOptions : [];
      const chosenPlacement = placementOptions[0];

      if (!chosenPlacement) {
        throw new Error(
          getEdgeFunctionMessage(
            null,
            placementData as Record<string, unknown> | undefined,
            "Amazon did not return a placement option yet. Please try again in a moment.",
          ),
        );
      }

      const shipmentIds = Array.isArray(chosenPlacement?.shipmentIds)
        ? chosenPlacement.shipmentIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
        : Array.isArray(chosenPlacement?.shipments)
          ? chosenPlacement.shipments
              .map((shipment: { shipmentId?: string }) => shipment?.shipmentId)
              .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
          : [];

      const placementOptionId =
        typeof chosenPlacement?.placementOptionId === "string" && chosenPlacement.placementOptionId.length > 0
          ? chosenPlacement.placementOptionId
          : undefined;

      if (placementOptionId && placementOptionId !== "fallback-from-shipments") {
        const { data: confirmData, error: confirmError } = await supabase.functions.invoke("confirm-placement", {
          body: { inboundPlanId, placementOptionId },
        });

        if (confirmError || !confirmData?.success) {
          const confirmPayload = await getEdgeFunctionPayload(
            confirmError,
            confirmData as Record<string, unknown> | undefined,
          );
          const confirmDiagnostics = Array.isArray(confirmPayload?.stepResults)
            ? (confirmPayload.stepResults as AmazonStepDiagnostic[])
                .map((step) => ({ ...step, status: step.status ?? (step.success ? "success" : "failed") }))
            : [];
          stepDiagnostics.push(...confirmDiagnostics);
          latestStepDiagnostics = [...stepDiagnostics];
          const amazonProblems = Array.from(new Set([
            ...extractAmazonProblemMessages(confirmPayload?.details),
            ...extractAmazonProblemMessages(confirmPayload),
          ])).slice(0, 5);

          throw new Error(
            amazonProblems.length > 0
              ? `Amazon rejected placement: ${amazonProblems.join(" | ")}`
              : getEdgeFunctionMessage(
                  confirmError,
                  confirmPayload,
                  "Amazon has not finished creating the shipment yet",
                ),
          );
        }
      }

      if (!shipmentIds.length) {
        throw new Error("Amazon created the plan but did not return any shipment IDs yet");
      }

      const result: AmazonShipmentResult = {
        inboundPlanId,
        shipmentId: shipmentIds[0] ?? null,
        shipmentIds,
        placementOptionId,
        createdAt: new Date().toISOString(),
      };
      const normalizedStepDiagnostics = normalizeAmazonDiagnostics(stepDiagnostics);

      setDraft((current) => ({
        ...current,
        status: "synced",
        inboundPlanId: result.inboundPlanId,
        shipmentId: result.shipmentId ?? undefined,
        shipmentIds: result.shipmentIds,
        placementOptionId: result.placementOptionId,
        amazonShipmentCreatedAt: result.createdAt,
        amazonWriteAccessCode: undefined,
        amazonWriteAccessMessage: undefined,
        amazonWorkflowMessage: undefined,
        amazonStepDiagnostics: normalizedStepDiagnostics,
        syncStatusNote: isQuantityOnly
          ? "SKU quantities were synced to Amazon. Finish box sizes, weights, and final review in Seller Central."
          : "Shipment was created and confirmed in Amazon.",
        updatedAt: result.createdAt,
      }));

      setShipmentLibrary((current) => {
        const currentEntry = current.find((entry) => entry.id === draft.id) ?? draft;
        return upsertShipmentRecord(current, {
          ...currentEntry,
          ...draft,
          status: "synced",
          inboundPlanId: result.inboundPlanId,
          shipmentId: result.shipmentId ?? undefined,
          shipmentIds: result.shipmentIds,
          placementOptionId: result.placementOptionId,
          amazonShipmentCreatedAt: result.createdAt,
          amazonWriteAccessCode: undefined,
          amazonWriteAccessMessage: undefined,
          amazonWorkflowMessage: undefined,
          amazonStepDiagnostics: normalizedStepDiagnostics,
          syncStatusNote: isQuantityOnly
            ? "SKU quantities were synced to Amazon. Finish box sizes, weights, and final review in Seller Central."
            : "Shipment was created and confirmed in Amazon.",
          updatedAt: result.createdAt,
        });
      });
      setFocusedShipmentId(draft.id);

      toast.success(isQuantityOnly ? "Qty-only shipment created in Amazon" : "Shipment created in Amazon", {
        description: result.shipmentId
          ? isQuantityOnly
            ? `Shipment ${result.shipmentId} is now created in Amazon. Finish box sizes, weights, and the final review in Seller Central.`
            : `Shipment ${result.shipmentId} was created in full workflow mode and confirmed in Amazon.`
          : "Amazon shipment created successfully.",
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : "Failed to create shipment in Amazon";
      const normalizedStepDiagnostics = latestStepDiagnostics.length
        ? normalizeAmazonDiagnostics(latestStepDiagnostics)
        : undefined;

      // If the failure message is generic (e.g. "Edge Function returned a non-2xx
      // status code") AND we already have an inbound plan ID from a prior step,
      // automatically pull Amazon's real operationProblems so the user sees the
      // actual reason (MSKU not active, prep mismatch, hazmat, etc.) instead of a
      // useless edge-function generic error.
      const isGenericEdgeError =
        /non-2xx|edge function|failed to fetch|networkerror|failed to create inbound plan/i.test(message) ||
        message === "Failed to create shipment in Amazon";
      const planIdForLookup =
        latestStepDiagnostics
          .map((s) => s.inboundPlanId)
          .find((v): v is string => typeof v === "string" && v.length > 0) ??
        draft.inboundPlanId;

      if (isGenericEdgeError && planIdForLookup) {
        try {
          const { data: statusData } = await supabase.functions.invoke("check-inbound-plan-status", {
            body: { inboundPlanId: planIdForLookup },
          });
          const opErrors = Array.isArray(statusData?.operationErrors) ? statusData.operationErrors : [];
          const realReasons: string[] = opErrors
            .flatMap((e: unknown) => {
              if (!e || typeof e !== "object" || !("messages" in e)) return [];
              const messages = (e as { messages?: unknown }).messages;
              return Array.isArray(messages) ? messages : [];
            })
            .filter((m: unknown): m is string => typeof m === "string" && m.length > 0);
          const enriched =
            (statusData?.error as string | undefined) ??
            (realReasons.length > 0 ? realReasons.slice(0, 3).join(" | ") : undefined);
          if (enriched) {
            message = `Amazon rejected the inbound plan: ${enriched}`;
          }
        } catch (lookupErr) {
          console.warn("[ShipmentBuilder] auto check-inbound-plan-status failed:", lookupErr);
        }
      }

      const failedAt = new Date().toISOString();
      setDraft((current) => {
        if (current.amazonWriteAccessCode === AMAZON_INBOUND_WRITE_ACCESS_CODE) {
          return current;
        }

        return {
          ...current,
          amazonWorkflowMessage: message,
          amazonStepDiagnostics: normalizedStepDiagnostics,
          syncStatusNote: "Amazon returned an error before the shipment could be completed.",
          updatedAt: failedAt,
        };
      });
      setShipmentLibrary((current) => {
        const currentEntry = current.find((entry) => entry.id === draft.id) ?? draft;
        if (currentEntry.amazonWriteAccessCode === AMAZON_INBOUND_WRITE_ACCESS_CODE) return current;
        return upsertShipmentRecord(current, {
          ...currentEntry,
          amazonWorkflowMessage: message,
          amazonStepDiagnostics: normalizedStepDiagnostics,
          syncStatusNote: "Amazon returned an error before the shipment could be completed.",
          updatedAt: failedAt,
        }, user?.id);
      });
      toast.error("Shipment creation failed", { description: message, duration: 10000 });
    } finally {
      setShipmentSubmitting(false);
    }
  };

  const hasAmazonPlanAccepted = Boolean(
    draft.amazonStepDiagnostics?.some((step) => step.step === "createInboundPlan" && (step.status === "success" || step.success)),
  );
  const hasAmazonCreation = Boolean(
    draft.shipmentId || draft.inboundPlanId || draft.continuedToAmazonAt || hasAmazonPlanAccepted,
  );
  const hasAmazonWriteAccessBlocker = draft.amazonWriteAccessCode === AMAZON_INBOUND_WRITE_ACCESS_CODE;
  const hasAmazonWorkflowWarning = Boolean(draft.amazonWorkflowMessage);
  const amazonProgressSummary = getAmazonProgressSummary(draft);
  const hasAmazonStatusContent = hasAmazonCreation || hasAmazonWorkflowWarning || hasAmazonWriteAccessBlocker;

  // Auto-open the Amazon status dialog when a new plan/shipment/error is produced
  useEffect(() => {
    if (!hasAmazonStatusContent) return;
    const key = [
      draft.id,
      draft.inboundPlanId ?? "",
      draft.shipmentId ?? "",
      draft.amazonWorkflowMessage ?? "",
      draft.amazonWriteAccessCode ?? "",
    ].join("|");
    if (lastAmazonStatusKeyRef.current !== key) {
      lastAmazonStatusKeyRef.current = key;
      setAmazonStatusModalOpen(true);
    }
  }, [
    hasAmazonStatusContent,
    draft.id,
    draft.inboundPlanId,
    draft.shipmentId,
    draft.amazonWorkflowMessage,
    draft.amazonWriteAccessCode,
  ]);


  // Classify the actual failure so we don't always blame "connection/permissions".
  // Look at the first failed step's amazonCode + httpStatus + message.
  const packingUnsupportedStep = draft.amazonStepDiagnostics?.find(
    (step) =>
      step.step === "generatePackingOptions" &&
      (step.code === "PACKING_OPTIONS_NOT_SUPPORTED" || /does not support packing options/i.test(step.details ?? step.message)),
  );
  const isPackingUnsupported = Boolean(packingUnsupportedStep);
  const firstFailedStep = draft.amazonStepDiagnostics?.find(
    (step) =>
      (step.status ?? (step.success ? "success" : "failed")) === "failed" &&
      !(step.step === "generatePackingOptions" && /does not support packing options/i.test(step.details ?? step.message)),
  );
  const amazonProblemMessage = Array.from(new Set([
    ...extractAmazonProblemMessages(firstFailedStep?.details),
    ...extractAmazonProblemMessages(draft.amazonWorkflowMessage),
  ])).join(" | ");
  const failureCode = firstFailedStep?.code;
  const failureHttpStatus = firstFailedStep?.httpStatus;
  const failureMessage = amazonProblemMessage || firstFailedStep?.message || (isPackingUnsupported ? packingUnsupportedStep?.message : draft.amazonWorkflowMessage) || "";
  const backendExpirationContext = getExpirationContextFromDraft(draft);
  const selectedWithoutExpiration = selectedItems.filter((item) => !item.expirationDate);
  const likelyDateSensitiveWithoutExpiration = selectedWithoutExpiration.filter((item) =>
    /food|grocery|beverage|drink|supplement|vitamin|pet|dog|cat|treat|salt|garlic|seasoning|sauce|snack|candy|coffee|tea|health|beauty|cosmetic|skincare|topical|personal[_\s-]?care/i.test(
      `${item.sku} ${item.title}`,
    ),
  );
  const expirationFailureContext: AmazonExpirationContext | null = backendExpirationContext ?? (
    isExpirationRequiredMessage(failureMessage)
      ? {
          message: "Amazon says an expiration date is required but did not identify the exact SKU.",
          suspectedProducts: (likelyDateSensitiveWithoutExpiration.length > 0 ? likelyDateSensitiveWithoutExpiration : selectedWithoutExpiration)
            .map((item) => ({ sku: item.sku, asin: item.asin, title: item.title })),
          amazonMessage: failureMessage,
        }
      : null
  );
  const expirationSuspectedProducts = expirationFailureContext?.suspectedProducts?.length
    ? expirationFailureContext.suspectedProducts
    : expirationFailureContext?.missingExpirationProducts ?? [];

  // Parse SKUs explicitly mentioned in Amazon's error message (e.g. "SKU(s): HM7-KLY-TGHJ"
  // or "resource 'HM7-KLY-TGHJ'") so we can highlight them even when the backend
  // didn't pre-populate `mentionedSkus`.
  const expirationFlaggedSkus = useMemo(() => {
    const skuSet = new Set<string>();
    (expirationFailureContext?.mentionedSkus ?? []).forEach((s) => s && skuSet.add(s));
    expirationSuspectedProducts.forEach((p) => p?.sku && skuSet.add(p.sku));
    const haystack = [
      expirationFailureContext?.amazonMessage,
      expirationFailureContext?.message,
      failureMessage,
    ].filter(Boolean).join(" | ");
    if (haystack) {
      selectedItems.forEach((item) => {
        if (!item.sku) return;
        const re = new RegExp(`(^|[^A-Za-z0-9_-])${item.sku.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}([^A-Za-z0-9_-]|$)`, "i");
        if (re.test(haystack)) skuSet.add(item.sku);
      });
    }
    return Array.from(skuSet);
  }, [expirationFailureContext, expirationSuspectedProducts, failureMessage, selectedItems]);

  const flaggedExpirationItems = useMemo(
    () => selectedItems.filter((item) => expirationFlaggedSkus.includes(item.sku)),
    [selectedItems, expirationFlaggedSkus],
  );

  // When Amazon flags specific SKU(s), auto-enable "Requires expiration" and
  // remember which IDs to highlight. Do NOT change the current step — the user
  // can fill the date inline in whatever step they're on (3, 4, 6, or review).
  useEffect(() => {
    if (!expirationFailureContext || flaggedExpirationItems.length === 0) return;
    const signature = `${draft.inboundPlanId ?? ""}::${flaggedExpirationItems.map((i) => i.id).sort().join(",")}`;
    if (handledExpirationSignatureRef.current === signature) return;
    handledExpirationSignatureRef.current = signature;

    const idsNeedingToggle = flaggedExpirationItems.filter((item) => !item.expirationRequired).map((item) => item.id);
    if (idsNeedingToggle.length > 0) {
      applyExpirationRequirementBulk(idsNeedingToggle, true);
    }
    setFlaggedExpirationItemIds(flaggedExpirationItems.map((item) => item.id));
    toast.warning("Expiration date required", {
      description: `Enabled "Requires expiration" for ${flaggedExpirationItems.length} flagged SKU(s). Enter the printed date in this step and recreate the shipment.`,
      duration: 8000,
    });
  }, [expirationFailureContext, flaggedExpirationItems, draft.inboundPlanId]);


  const isInvalidMskuFailure =
    failureCode === "BadRequest" && /msku/i.test(failureMessage) && /not\s+valid|invalid/i.test(failureMessage);
  const isAuthFailure =
    failureCode === "Unauthorized" || failureCode === "Forbidden" || failureHttpStatus === 401 || failureHttpStatus === 403;
  const isQuotaFailure = failureCode === "QuotaExceeded" || failureHttpStatus === 429;
  const isAmazonServerFailure = typeof failureHttpStatus === "number" && failureHttpStatus >= 500;

  let workflowHeading: string;
  let workflowBody: string;
  let workflowHint: string;

  if (isPackingUnsupported) {
    workflowHeading = "Amazon accepted the plan and skipped packing";
    workflowBody =
      "Amazon created the inbound plan successfully. This plan type does not support packing options through the API, so that step was skipped.";
    workflowHint =
      "Continue in Seller Central to finish the remaining shipment steps there. This is expected for your current workflow.";
  } else if (expirationFailureContext) {
    workflowHeading = "Expiration date required";
    workflowBody = expirationFailureContext.message || failureMessage || "Amazon requires an expiration date for one of the selected products.";
    workflowHint = "Open Quantities & Compliance, turn on Requires expiration for the SKU(s) below, enter the date printed on the product, and recreate the shipment.";
  } else if (hasAmazonPlanAccepted && draft.creationMode === "quantity-only") {
    workflowHeading = "Inbound plan created in Amazon";
    workflowBody =
      "Amazon accepted the inbound plan with your SKUs and quantities. The actual shipment has NOT been created yet — you need to finish placement, boxes, weights and confirmation in Seller Central for a real shipment to appear.";
    workflowHint =
      "Open Seller Central to finalize the shipment. The plan ID above will already be loaded there.";
  } else if (hasAmazonPlanAccepted) {
    workflowHeading = "Amazon accepted the first step";
    workflowBody =
      "InventorySprint successfully submitted the initial shipment plan to Amazon, but the automatic transfer was not fully completed.";
    workflowHint =
      "Finish the remaining process in Seller Central, or complete the missing Amazon API steps later when supported.";
  } else if (isInvalidMskuFailure) {
    workflowHeading = "One or more SKUs are not in your Amazon catalog";
    workflowBody =
      failureMessage ||
      "Amazon rejected the shipment because at least one SKU is not registered in your Seller Central catalog.";
    workflowHint =
      "Open Manage Inventory in Seller Central, confirm the exact MSKU for each item, then update the SKU here and retry.";
  } else if (isAuthFailure) {
    workflowHeading = "Amazon connection / permissions issue";
    workflowBody =
      failureMessage ||
      "Amazon rejected the request because the connection or required permissions are missing or expired.";
    workflowHint =
      "Reconnect Amazon (Settings → Integrations) and make sure the FBA Inbound role is granted, then retry.";
  } else if (isQuotaFailure) {
    workflowHeading = "Amazon rate limit hit";
    workflowBody =
      failureMessage || "Amazon temporarily throttled the request because too many calls were made in a short window.";
    workflowHint = "Wait about a minute and retry — this usually resolves itself.";
  } else if (isAmazonServerFailure) {
    workflowHeading = "Amazon service is temporarily unavailable";
    workflowBody = failureMessage || "Amazon's API returned a server error before the shipment could be created.";
    workflowHint = "This is on Amazon's side. Wait a moment and retry the shipment.";
  } else {
    workflowHeading = "Amazon did not finish creating the shipment";
    workflowBody =
      failureMessage ||
      "Amazon did not complete the initial shipment creation request, so nothing usable may be visible in Seller Central yet.";
    workflowHint = "Check the Amazon error details below, fix the issue, and retry the shipment creation.";
  }

  const saveNow = () => {
    const nextDraft = { ...draft, updatedAt: new Date().toISOString() };
    setAutosaveReady(true);
    setDraft(nextDraft);
    localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, JSON.stringify(nextDraft));
    setShipmentLibrary((current) => upsertShipmentRecord(current, nextDraft, user?.id));
    toast.success("Draft saved");
  };

  const libraryMetrics = {
    drafts: draftShipments.length,
    continued: shipmentLibrary.filter((entry) => entry.status === "continued").length,
    synced: shipmentLibrary.filter((entry) => entry.status === "synced").length,
    completed: shipmentLibrary.filter((entry) => entry.status === "completed").length,
    archived: archivedShipments.length,
  };

  const amazonStatusPanel = (
    <div className="rounded-md border p-4 lg:max-w-md">
      <p className="font-medium">Amazon Status</p>
      {hasAmazonCreation ? (
        <div className="mt-4 space-y-4 text-sm">
          {draft.inboundPlanId ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 p-4">
              <p className="font-semibold text-foreground">
                {draft.shipmentId
                  ? "Inbound plan in Amazon — open Seller Central to finish"
                  : "Inbound plan created in Amazon — finish boxes & weights in Seller Central"}
              </p>
              <p className="mt-1 text-muted-foreground">
                {draft.shipmentId
                  ? "Amazon has shipment IDs for this plan. Open Send to Amazon to set placement, box sizes, weights and confirm."
                  : "Amazon accepted the SKUs and quantities, but the actual shipment is NOT created yet. You must open Send to Amazon to set placement, box sizes, weights and confirm — only then will a real shipment appear in Seller Central."}
              </p>
              <Button
                type="button"
                onClick={handleContinueInAmazon}
                className="mt-3 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-bold"
              >
                <ExternalLink className="h-4 w-4" />
                {draft.shipmentId ? "Continue in Amazon Seller Central" : "Finish boxes & weights in Seller Central"}
              </Button>
            </div>
          ) : null}
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-muted-foreground">Inbound Plan ID</p>
                <p className="mt-1 font-medium break-all">{draft.inboundPlanId}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCopyInboundPlanId}
                  className="gap-2 text-foreground"
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCheckPlanStatus}
                  disabled={checkPlanStatusBusy}
                  className="gap-2 text-foreground"
                >
                  {checkPlanStatusBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Check Plan Status
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This ID is internal to Amazon's API and won't be searchable in Seller Central. Use "Check Plan Status" to verify Amazon still has this plan, or "Finish boxes & weights in Seller Central" above to open the workflow directly.
            </p>
          </div>
          {draft.shipmentId ? (
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-muted-foreground">Shipment ID</p>
              <p className="mt-1 font-medium break-all">{draft.shipmentId}</p>
            </div>
          ) : null}
          {draft.shipmentId && draft.shipmentIds && draft.shipmentIds.length > 1 ? (
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-muted-foreground">All Amazon Shipment IDs</p>
              <div className="mt-2 space-y-1">
                {draft.shipmentIds.map((shipmentId) => (
                  <p key={shipmentId} className="font-medium break-all">{shipmentId}</p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {hasAmazonWriteAccessBlocker ? (
            <div className="rounded-md border p-3">
              <p className="font-medium">{draft.amazonWriteAccessMessage ?? AMAZON_INBOUND_WRITE_ACCESS_BANNER}</p>
              <p className="mt-1 text-sm text-muted-foreground">{AMAZON_INBOUND_WRITE_ACCESS_FALLBACK}</p>
            </div>
          ) : null}
          {hasAmazonWorkflowWarning ? (
            <div className="rounded-md border p-3">
              <p className="font-medium">{workflowHeading}</p>
              <p className="mt-1 text-sm text-muted-foreground">{workflowBody}</p>
              {failureCode || typeof failureHttpStatus === "number" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Amazon error{failureCode ? `: ${failureCode}` : ""}
                  {typeof failureHttpStatus === "number" ? ` (HTTP ${failureHttpStatus})` : ""}
                </p>
              ) : null}
              {draft.inboundPlanId ? (
                <div className="mt-3 rounded-md border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Inbound Plan ID</p>
                  <p className="mt-1 font-medium break-all">{draft.inboundPlanId}</p>
                </div>
              ) : null}
              {expirationFailureContext ? (
                <div className="mt-3 rounded-md border bg-muted/20 p-3">
                  <p className="text-sm font-medium">SKU(s) to check for expiration dates</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {expirationSuspectedProducts.length > 0 ? (
                      expirationSuspectedProducts.map((product, index) => {
                        const matchedItem = selectedItems.find((item) => item.sku === product.sku || item.asin === product.asin);
                        return (
                          <button
                            key={`${product.sku ?? product.asin ?? index}`}
                            type="button"
                            onClick={() => {
                              if (matchedItem) {
                                setCurrentStep(3);
                                window.setTimeout(() => scrollToComplianceItem(matchedItem.id), 50);
                              }
                            }}
                            className="rounded-md border px-2 py-1 text-left text-xs underline-offset-4 hover:underline"
                          >
                            {product.sku ?? product.asin ?? "Unknown SKU"}
                          </button>
                        );
                      })
                    ) : (
                      <span className="text-sm text-muted-foreground">Amazon did not provide the SKU. Check food, grocery, supplement, beauty, pet, and other date-sensitive items.</span>
                    )}
                  </div>
                  {expirationFailureContext.amazonMessage ? (
                    <p className="mt-2 text-xs text-muted-foreground break-words">Amazon message: {expirationFailureContext.amazonMessage}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">Step reached</p>
                {amazonProgressSummary.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm">
                    <span>{item.label}</span>
                    <Badge variant={item.state === "done" ? "secondary" : item.state === "current" ? "default" : "outline"}>
                      {item.state === "done" ? "Done" : item.state === "current" ? "Next" : "Later"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {hasAmazonWriteAccessBlocker || hasAmazonWorkflowWarning ? (
            <p className="text-sm text-muted-foreground">
              {hasAmazonWriteAccessBlocker ? AMAZON_INBOUND_WRITE_ACCESS_FALLBACK : workflowHint}
            </p>
          ) : null}
          {isAdmin && draft.amazonStepDiagnostics?.length ? (
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-medium">Amazon step diagnostics</p>
                <Button type="button" variant="outline" size="sm" onClick={handleCopyAmazonDebugDetails} className="gap-2">
                  <Copy className="h-4 w-4" />
                  Copy debug details
                </Button>
              </div>
              <div className="mt-3 space-y-3">
                {draft.amazonStepDiagnostics.map((step, index) => {
                  const status = step.status ?? (step.success ? "success" : "failed");

                  return (
                    <div key={`${step.step}-${index}`} className="rounded-md border bg-muted/20 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{step.step}</p>
                        <Badge variant={status === "success" ? "secondary" : "outline"}>{status}</Badge>
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                        <p>Endpoint: {step.endpoint}</p>
                        <p>Status: {status}</p>
                        {typeof step.httpStatus === "number" ? <p>HTTP status: {step.httpStatus}</p> : null}
                        {step.code ? <p>Amazon code: {step.code}</p> : null}
                        <p>{step.message}</p>
                        {step.inboundPlanId ? <p>Inbound plan ID: {step.inboundPlanId}</p> : null}
                        {step.operationId ? <p>Operation ID: {step.operationId}</p> : null}
                        {step.shipmentIds?.length ? <p>Shipment IDs: {step.shipmentIds.join(", ")}</p> : null}
                        {step.details ? <p className="break-words">Details: {step.details}</p> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  return (
    <div className="dark min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      <Helmet>
        <title>FBA Shipment Builder | InventorySprint</title>
        <meta
          name="description"
          content="Build and create your FBA shipment in InventorySprint, then finish the final Amazon review in Seller Central."
        />
      </Helmet>

      {/* Animated gradient orbs (Repricer-style backdrop) */}
      <div className="pointer-events-none absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="pointer-events-none absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <Navbar />

      <main className="flex-1 pt-24 pb-12 relative z-10">
        <div className="container mx-auto max-w-7xl px-4">
          <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="w-full">
              {(() => {
                const isCreationModeLocked = draft.step > 1;
                return (
                  <>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold tracking-tight text-white">FBA Shipment Builder</h1>
                {/* BusinessModeBanner hidden per user request */}
              </div>
              <p className="mt-2 text-white/70">
                Plan, save, merge, and track FBA shipments in one place — then finish in Amazon.
              </p>
              {draft.step <= 3 ? (
                <div className="mt-4">
                  <BusinessModePanels draft={draft} />
                </div>
              ) : null}
              {isCreationModeLocked ? (
                <div className="sticky top-24 z-20 mt-4 flex flex-row items-center gap-3 rounded-xl border border-white/15 bg-shipment-surface p-3 shadow-lg backdrop-blur-md">
                  {(() => {
                    const isReadOnly = Boolean(draft.continuedToAmazonAt) || draft.status === "synced" || draft.status === "completed" || draft.status === "archived";
                    return (
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-white truncate">
                          {isReadOnly ? "View only: " : "Editing: "}
                          <span className="text-primary">{draft.shipmentName || "Untitled shipment"}</span>
                        </p>
                        <p className="text-sm text-white/60">
                          {isReadOnly ? "This shipment has been continued to Amazon and is read-only." : `Auto-saving as you work · Last saved ${new Date(draft.updatedAt).toLocaleTimeString()}`}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge className="bg-white/10 text-white border-white/15 hover:bg-white/15">{selectedItems.length} SKUs</Badge>
                          <Badge className="bg-white/10 text-white border-white/15 hover:bg-white/15">{totalUnits} units</Badge>
                          <Badge variant={getStatusBadgeVariant(draft.status)}>{getShipmentStatusLabel(draft.status)}</Badge>
                        </div>
                      </div>
                    );
                  })()}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      saveNow();
                      resetDraft();
                      setWorkspaceSection("drafts");
                      setSearch(""); setSearchQuery("");
                    }}
                    className="gap-2 bg-white/90 hover:bg-white text-[hsl(221,90%,22%)] hover:text-[hsl(221,90%,22%)] font-bold border-white/30"
                  >
                    <X className="h-4 w-4" />
                    Close
                  </Button>
                </div>
              ) : (
              <div className="sticky top-24 z-20 mt-4 rounded-xl border border-white/15 bg-white/10 p-4 shadow-lg backdrop-blur-md text-white">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)_auto] xl:items-end">
                  <div className="space-y-2">
                    <div>
                      <p className="font-semibold">Create Shipment</p>
                      <p className="text-sm text-muted-foreground">
                        Start the draft here. Auto-save begins as soon as you create it and the shipment enters your workspace.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-name">Shipment Name</Label>
                      <Input
                        id="shipment-name"
                        value={draft.shipmentName}
                        onChange={(event) => setDraft((current) => ({ ...current, shipmentName: event.target.value }))}
                        placeholder="e.g. June Restock Batch 01"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-3 rounded-md border p-4">
                    <p className="font-medium">Shipment creation mode</p>
                    <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
                      <button
                        type="button"
                        disabled={isCreationModeLocked}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            creationMode: "quantity-only",
                          }))
                        }
                        className={`rounded-md border px-4 py-3 text-left transition-colors ${
                          draft.creationMode === "quantity-only" ? "border-primary bg-accent" : "border-border"
                        } ${isCreationModeLocked ? "cursor-not-allowed opacity-60" : ""
                        }`}
                        aria-pressed={draft.creationMode === "quantity-only"}
                      >
                        <span className="font-medium">Only create with quantities</span>
                      </button>

                      <div className="flex items-center justify-center rounded-md border px-4 py-3">
                        <div className="flex flex-col items-center gap-2">
                          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Slide</span>
                          <Switch
                            checked={draft.creationMode === "full-workflow"}
                            disabled={isCreationModeLocked}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                creationMode: checked ? "full-workflow" : "quantity-only",
                              }))
                            }
                            aria-label="Toggle shipment creation mode"
                          />
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={isCreationModeLocked}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            creationMode: "full-workflow",
                          }))
                        }
                        className={`rounded-md border px-4 py-3 text-left transition-colors ${
                          draft.creationMode === "full-workflow" ? "border-primary bg-accent" : "border-border"
                        } ${isCreationModeLocked ? "cursor-not-allowed opacity-60" : ""
                        }`}
                        aria-pressed={draft.creationMode === "full-workflow"}
                      >
                        <span className="font-medium">Full workflow</span>
                      </button>
                    </div>
                  </div>
                  <Button onClick={initializeDraft} size="lg" disabled={!draft.shipmentName.trim()} className="gap-2 xl:self-end">
                    Create Shipment Draft
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              )}
                  </>
                );
              })()}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={resetDraft} className="gap-2 bg-white/90 hover:bg-white text-[hsl(221,90%,22%)] hover:text-[hsl(221,90%,22%)] font-bold border-white/30">
                <RefreshCw className="h-4 w-4" />
                  Start New Draft
              </Button>
            </div>
          </div>

          {draft.step <= 1 && selectedItems.length === 0 ? (
          <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {[
              { label: "Created Qty / Drafts", value: libraryMetrics.drafts, icon: Save, primary: true, hint: "Shipments with quantities entered" },
              { label: "Continued to Amazon", value: libraryMetrics.continued, icon: ExternalLink, primary: true, hint: "Sent to Seller Central" },
              { label: "Synced to Amazon", value: libraryMetrics.synced, icon: Send, primary: false, hint: "Full sync (future)" },
              { label: "Completed", value: libraryMetrics.completed, icon: CheckCircle2, primary: false, hint: "Manual or Amazon-confirmed" },
              { label: "Archived", value: libraryMetrics.archived, icon: Archive, primary: false, hint: "Old shipments" },
            ].map((metric) => (
              <div
                key={metric.label}
                className={
                  metric.primary
                    ? "rounded-xl border border-primary/40 bg-primary/15 p-4 shadow-lg backdrop-blur-md ring-1 ring-primary/30"
                    : "rounded-xl border border-white/15 bg-white/10 p-4 shadow-md backdrop-blur-md"
                }
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={metric.primary ? "text-sm font-medium text-white" : "text-sm text-white/60"}>{metric.label}</p>
                    <p className={metric.primary ? "mt-1 text-3xl font-bold text-white" : "mt-1 text-2xl font-bold text-white/90"}>{metric.value}</p>
                    <p className="mt-1 text-[11px] text-white/50">{metric.hint}</p>
                  </div>
                  <metric.icon className={metric.primary ? "h-5 w-5 text-primary-foreground" : "h-5 w-5 text-primary"} />
                </div>
              </div>
            ))}
          </div>
          ) : null}


          <Tabs value={workspaceSection} onValueChange={(value) => setWorkspaceSection(value as WorkspaceSection)} className="mb-6 space-y-6">
            {workspaceSection !== "new" && (
              <TabsList className="grid h-auto w-full grid-cols-1 gap-2 bg-white/80 backdrop-blur-sm border border-white/30 p-1 text-[hsl(221,100%,10%)] font-bold md:grid-cols-5">
                <TabsTrigger value="drafts">Drafts</TabsTrigger>
                <TabsTrigger value="continued" className="gap-2">
                  Continued to Amazon
                  {continuedShipments.length > 0 ? (
                    <Badge variant="secondary" className="ml-1">{continuedShipments.length}</Badge>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="synced">Sent / Synced</TabsTrigger>
                <TabsTrigger value="archived">Archived</TabsTrigger>
                <TabsTrigger value="asin-history">ASIN History</TabsTrigger>
              </TabsList>
            )}

            <TabsContent value="new" className="mt-0 space-y-6">
              <div className="grid gap-6">

              </div>

              <Card className="bg-shipment-surface border-white/15 text-white">
                <CardContent className="p-4 md:p-6">
                  <div className="grid gap-3 md:grid-cols-4">
                    {STEPS.filter((s) => s.id !== 3 && s.id !== 5).map((step, idx) => {
                      const active = draft.step === step.id;
                      const complete = draft.step > step.id;
                      const displayNumber = idx + 1;
                      return (
                        <div
                          key={step.id}
                          className={`rounded-md border px-3 py-3 text-sm ${active ? "border-primary bg-primary/20 text-white" : complete ? "border-white/20 bg-shipment-row-alt text-white" : "border-white/15 bg-shipment-row-alt text-white/80"}`}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-semibold text-white">Step {displayNumber}</span>
                            {complete ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
                          </div>
                          <div className={active ? "text-white" : "text-white/70"}>{step.title}</div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="drafts" className="mt-0 space-y-6">
              <Card className="bg-[hsl(220,65%,22%)] text-white border-white/10 shadow-xl">
                <CardHeader>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <CardTitle className="text-white">Draft management</CardTitle>
                      <CardDescription className="text-white/70">Resume, rename, duplicate, delete, or merge multiple drafts into one shipment plan.</CardDescription>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <Select value={draftSort} onValueChange={(value) => setDraftSort(value as DraftSortOption)}>
                        <SelectTrigger className="w-full sm:w-[220px] bg-[hsl(210,50%,42%)] text-white border-white/15">
                          <SelectValue placeholder="Sort drafts" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="updated-desc">Last updated: newest</SelectItem>
                          <SelectItem value="updated-asc">Last updated: oldest</SelectItem>
                          <SelectItem value="created-desc">Created: newest</SelectItem>
                          <SelectItem value="created-asc">Created: oldest</SelectItem>
                          <SelectItem value="name-asc">Name: A to Z</SelectItem>
                          <SelectItem value="name-desc">Name: Z to A</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button onClick={openMergeDialog} disabled={!canMergeDrafts} className="gap-2">
                        <Layers3 className="h-4 w-4" />
                        Merge selected drafts
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => refreshShipmentLibraryFromCloud({ hydrateActive: true })}
                        disabled={libraryRefreshing}
                        className="gap-2 bg-white/10 hover:bg-white/20 text-white border-white/20"
                      >
                        {libraryRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        Refresh cloud
                      </Button>
                    </div>
                  </div>
                  {lastLibraryRefreshAt ? (
                    <p className="mt-2 text-xs text-white/50">Last cloud refresh {new Date(lastLibraryRefreshAt).toLocaleTimeString()}</p>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-4">
                  {showCloudLoadingState ? (
                    <div className="rounded-md border border-white/10 bg-[hsl(220,65%,22%)] p-6 text-sm text-white/60">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      Loading shipment drafts from cloud…
                    </div>
                  ) : draftShipments.length === 0 ? (
                    <div className="rounded-md border border-white/10 bg-[hsl(220,65%,22%)] p-6 text-sm text-white/60">No drafts yet. Start a shipment to build your draft library.</div>
                  ) : (
                    <Table containerClassName="rounded-md border border-white/10 bg-shipment-row-alt">
                      <TableHeader className="bg-[hsl(220,65%,18%)]">
                        <TableRow className="hover:bg-transparent border-white/10">
                          <TableHead className="w-12">
                            <Checkbox
                              checked={sortedDraftShipments.length > 0 && sortedDraftShipments.every((entry) => selectedLibraryIds.includes(entry.id))}
                              onCheckedChange={(checked) => setSelectedLibraryIds(checked ? sortedDraftShipments.map((entry) => entry.id) : [])}
                              aria-label="Select all drafts"
                            />
                          </TableHead>
                          <TableHead className="text-white/80">Shipment Name</TableHead>
                          <TableHead className="text-white/80">Created Date</TableHead>
                          <TableHead className="text-white/80">Last Updated</TableHead>
                          <TableHead className="text-white/80">Total SKUs</TableHead>
                          <TableHead className="text-white/80">Total Units</TableHead>
                          <TableHead className="text-white/80">Box Count</TableHead>
                          <TableHead className="text-white/80">Status</TableHead>
                          <TableHead className="text-right text-white/80">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedDraftShipments.map((entry, idx) => {
                          const entryItems = getSelectedDraftItems(entry);
                          const entryUnits = entryItems.reduce((sum, item) => sum + item.qtyToShip, 0);
                          const isMerged = Boolean(entry.mergedFrom?.length);

                          return (
                            <TableRow key={entry.id} className={`border-white/10 hover:!bg-shipment-row-hover ${idx % 2 === 0 ? 'bg-shipment-row' : 'bg-shipment-row-alt'}`}>
                              <TableCell>
                                <Checkbox
                                  checked={selectedLibraryIds.includes(entry.id)}
                                  onCheckedChange={(checked) => toggleLibrarySelection(entry.id, Boolean(checked))}
                                  aria-label={`Select ${entry.shipmentName || "Untitled shipment"}`}
                                />
                              </TableCell>
                              <TableCell>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFocusedShipmentId(entry.id);
                                    openShipmentDraft(entry);
                                  }}
                                  className="text-left font-medium text-white hover:underline"
                                >
                                  {entry.shipmentName || "Untitled shipment"}
                                </button>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Badge variant={isMerged ? "default" : "secondary"} className={isMerged ? "" : "bg-white/10 text-white border-white/15 hover:bg-white/15"}>{isMerged ? "Merged" : "Original"}</Badge>
                                  <Badge variant="outline" className="border-white/20 text-white/80">{entry.creationMode === "quantity-only" ? "Qty-only" : "Full workflow"}</Badge>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/80">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                              <TableCell className="text-white/80">{new Date(entry.updatedAt).toLocaleString()}</TableCell>
                              <TableCell className="text-white/90">{entryItems.length}</TableCell>
                              <TableCell className="text-white/90">{entryUnits}</TableCell>
                              <TableCell className="text-white/90">{entry.numberOfBoxes}</TableCell>
                              <TableCell>
                                <Badge variant={getStatusBadgeVariant(entry.status)}>{getShipmentStatusLabel(entry.status)}</Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-2">
                                  <Button variant="outline" size="sm" onClick={() => { setFocusedShipmentId(entry.id); openShipmentDraft(entry); }} className="gap-2 bg-white/10 hover:bg-white/20 text-white border-white/20"><Eye className="h-4 w-4" />Open</Button>
                                  <Button variant="outline" size="sm" onClick={() => duplicateShipment(entry)} className="gap-2 bg-white/10 hover:bg-white/20 text-white border-white/20"><Copy className="h-4 w-4" />Duplicate</Button>
                                  <Button variant="outline" size="sm" onClick={() => deleteShipment(entry)} className="gap-2 bg-white/10 hover:bg-white/20 text-white border-white/20"><Trash2 className="h-4 w-4" />Delete</Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="continued" className="mt-0 space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <CardTitle>Continued to Amazon</CardTitle>
                      <CardDescription>
                        Shipments you sent to Seller Central. Finish placement, boxes, weights, and confirmation in Amazon, then mark as synced here.
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <span className="text-sm text-white/70 mr-1">Filter:</span>
                      <Button
                        type="button"
                        size="sm"
                        variant={continuedDateFilter === "all" ? "default" : "outline"}
                        onClick={() => setContinuedDateFilter("all")}
                      >
                        All
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={continuedDateFilter === "week" ? "default" : "outline"}
                        onClick={() => setContinuedDateFilter("week")}
                      >
                        This Week
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={continuedDateFilter === "month" ? "default" : "outline"}
                        onClick={() => setContinuedDateFilter("month")}
                      >
                        This Month
                      </Button>
                      <span className="ml-2 text-xs text-white/60">
                        Showing {filteredContinuedShipments.length} of {continuedShipments.length}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">

                  {filteredContinuedShipments.length === 0 ? (
                    <div className="rounded-md border p-6 text-sm text-muted-foreground">
                      {continuedShipments.length === 0
                        ? <>No shipments continued to Amazon yet. From a draft, click <span className="font-medium">Continue to Amazon</span> in step 6 to send it to Seller Central.</>
                        : <>No shipments continued to Amazon in the selected period.</>}
                    </div>
                  ) : (
                    filteredContinuedShipments.map((entry) => {
                      const entryItems = getSelectedDraftItems(entry);
                      return (
                        <div key={entry.id} className="rounded-md border border-white/10 bg-shipment-row-alt text-white p-4">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-2">
                              <div className="flex flex-wrap gap-2">
                                <p className="font-medium">{entry.shipmentName || "Untitled shipment"}</p>
                                <Badge variant={getStatusBadgeVariant(entry.status)}>{getShipmentStatusLabel(entry.status)}</Badge>
                              </div>
                              <p className="text-sm text-white/70">
                                {entryItems.length} SKUs • {entryItems.reduce((sum, item) => sum + item.qtyToShip, 0)} units • Updated {new Date(entry.updatedAt).toLocaleString()}
                              </p>
                              <div className="grid gap-2 md:grid-cols-3 text-sm">
                                <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                  <p className="text-white/70">Inbound Plan ID</p>
                                  <p className="mt-1 font-medium break-all">{entry.inboundPlanId ?? "Pending"}</p>
                                </div>
                                <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                  <p className="text-white/70">Shipment ID</p>
                                  <p className="mt-1 font-medium break-all">{entry.shipmentId ?? "Pending"}</p>
                                </div>
                                <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                  <p className="text-white/70">Total Cost</p>
                                  <p className="mt-1 font-medium">${computeEntryTotalCost(entryItems).toFixed(2)}</p>
                                </div>
                              </div>
                            </div>


                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(AMAZON_SELLER_CENTRAL_URL, "_blank", "noopener,noreferrer")}
                                className="gap-2"
                              >
                                <ExternalLink className="h-4 w-4" />
                                Open in Seller Central
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openShipmentDraft(entry)}
                                className="gap-2"
                                title="Reopen the wizard for this shipment to review the steps"
                              >
                                <Eye className="h-4 w-4" />
                                View steps
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => setFocusedShipmentId(entry.id)} className="gap-2">
                                <Eye className="h-4 w-4" />
                                Details
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => duplicateShipment(entry)}
                                className="gap-2"
                                title="Create a new editable draft pre-filled with this shipment's contents"
                              >
                                <Copy className="h-4 w-4" />
                                Duplicate as new draft
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => markShipmentCompleted(entry)} className="gap-2">
                                <CheckCircle2 className="h-4 w-4" />
                                Mark synced
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => archiveShipment(entry)} className="gap-2">
                                <Archive className="h-4 w-4" />
                                Archive
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="synced" className="mt-0 space-y-6">
              <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
                <Card>
                  <CardHeader>
                    <CardTitle>Shipment history</CardTitle>
                    <CardDescription>Internal visibility for what was drafted, synced, and completed in InventorySprint</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {syncedShipments.length === 0 ? (
                      <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white/70 p-6 text-sm">No synced shipments yet.</div>
                    ) : (
                      syncedShipments.map((entry) => {
                        const entryItems = getSelectedDraftItems(entry);
                        return (
                          <div key={entry.id} className="rounded-md border border-white/10 bg-shipment-row-alt text-white p-4">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="space-y-2">
                                <div className="flex flex-wrap gap-2">
                                  <p className="font-medium">{entry.shipmentName || "Untitled shipment"}</p>
                                  <Badge variant={getStatusBadgeVariant(entry.status)}>{getShipmentStatusLabel(entry.status)}</Badge>
                                </div>
                                <p className="text-sm text-white/70">
                                  {entryItems.length} SKUs • {entryItems.reduce((sum, item) => sum + item.qtyToShip, 0)} units • Updated {new Date(entry.updatedAt).toLocaleString()}
                                </p>
                                <div className="grid gap-2 md:grid-cols-3 text-sm">
                                  <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                    <p className="text-white/70">Inbound Plan ID</p>
                                    <p className="mt-1 font-medium break-all">{entry.inboundPlanId ?? "Pending"}</p>
                                  </div>
                                  <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                    <p className="text-white/70">Shipment ID</p>
                                    <p className="mt-1 font-medium break-all">{entry.shipmentId ?? "Pending"}</p>
                                  </div>
                                  <div className="rounded-md border border-white/10 bg-shipment-control p-3">
                                    <p className="text-white/70">Total Cost</p>
                                    <p className="mt-1 font-medium">${computeEntryTotalCost(entryItems).toFixed(2)}</p>
                                  </div>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" onClick={() => setFocusedShipmentId(entry.id)} className="gap-2"><Eye className="h-4 w-4" />Details</Button>
                                {entry.status !== "completed" ? (
                                  <Button variant="outline" size="sm" onClick={() => markShipmentCompleted(entry)} className="gap-2"><CheckCircle2 className="h-4 w-4" />Mark completed</Button>
                                ) : null}
                                <Button variant="outline" size="sm" onClick={() => archiveShipment(entry)} className="gap-2"><Archive className="h-4 w-4" />Archive</Button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Shipment detail</CardTitle>
                    <CardDescription>Open any shipment to see products, box setup, sync state, and merge source.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {focusedShipment ? (
                      <div className="space-y-4 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{focusedShipment.shipmentName || "Untitled shipment"}</p>
                          <Badge variant={getStatusBadgeVariant(focusedShipment.status)}>{getShipmentStatusLabel(focusedShipment.status)}</Badge>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-md border border-white/10 bg-shipment-control text-white p-3">
                            <p className="text-white/70">Box count</p>
                            <p className="mt-1 font-medium">{focusedShipment.numberOfBoxes}</p>
                          </div>
                          <div className="rounded-md border border-white/10 bg-shipment-control text-white p-3">
                            <p className="text-white/70">Sync status</p>
                            <p className="mt-1 font-medium">{focusedShipment.syncStatusNote ?? "Tracked inside InventorySprint"}</p>
                          </div>
                        </div>
                        <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white p-3">
                          <p className="font-medium">Products and quantities</p>
                          <div className="mt-3 space-y-2">
                            {getSelectedDraftItems(focusedShipment).map((item) => (
                              <div key={item.id} className="flex items-center justify-between gap-3">
                                <span>{item.sku}</span>
                                <span className="text-white/70">{item.qtyToShip} units</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {focusedShipment.mergedFrom?.length ? (
                          <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white p-3">
                            <p className="font-medium">Merge source</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {focusedShipment.mergedFrom.map((source) => (
                                <Badge key={source.id} variant="outline">{source.shipmentName}</Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white/70 p-6 text-sm">Select a shipment from Drafts or Sent / Synced to inspect its details.</div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="archived" className="mt-0">
              <Card>
                <CardHeader>
                  <CardTitle>Archived shipments</CardTitle>
                  <CardDescription>Keep old shipments visible without cluttering the active workspace.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {archivedShipments.length === 0 ? (
                    <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white/70 p-6 text-sm">No archived shipments yet.</div>
                  ) : (
                    archivedShipments.map((entry) => (
                      <div key={entry.id} className="rounded-md border border-white/10 bg-shipment-row-alt text-white p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{entry.shipmentName || "Untitled shipment"}</p>
                              <Badge variant="outline">Archived</Badge>
                            </div>
                            <p className="mt-1 text-sm text-white/70">
                              Archived {entry.archivedAt ? new Date(entry.archivedAt).toLocaleString() : new Date(entry.updatedAt).toLocaleString()}
                            </p>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => setFocusedShipmentId(entry.id)} className="gap-2">
                            <Eye className="h-4 w-4" />
                            View detail
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="asin-history" className="mt-0">
              <AsinShipmentHistoryTab
                shipments={shipmentLibrary.map((s) => ({
                  id: s.id,
                  shipmentName: s.shipmentName,
                  status: s.status,
                  createdAt: s.createdAt,
                  updatedAt: s.updatedAt,
                  completedAt: s.completedAt,
                  continuedToAmazonAt: s.continuedToAmazonAt,
                  items: s.items.map((it) => ({
                    asin: it.asin,
                    sku: it.sku,
                    title: it.title,
                    imageUrl: it.imageUrl,
                    qtyToShip: it.qtyToShip,
                  })),
                }))}
              />
            </TabsContent>
          </Tabs>


          {draft.step === 2 && (
            <Card className="bg-[hsl(220,65%,22%)] text-white border-white/10 shadow-xl overflow-hidden">
              <CardHeader className="sticky top-0 z-20 bg-[hsl(220,65%,22%)] border-b border-white/10 rounded-t-xl">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <CardTitle className="text-white">Select Products</CardTitle>
                    <CardDescription className="text-white/70">Choose products from your real inventory and enter Qty to Ship.</CardDescription>
                  </div>
                  <div className="w-full max-w-2xl space-y-2">
                    <Label htmlFor="inventory-search" className="text-white/80">Search inventory</Label>
                    <div className="flex gap-2">
                      <Input
                        id="inventory-search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        onKeyDown={(event) => {
                          // Enter / Return commits the query on every platform
                          // (incl. macOS / iPadOS — Apple "Return" key fires
                          // the same 'Enter' KeyboardEvent.key).
                          if (event.key === "Enter") {
                            event.preventDefault();
                            setSearchQuery(search.trim());
                          }
                        }}
                        placeholder="Search by SKU, ASIN, or title — press Enter or Search"
                        className="bg-[hsl(210,50%,42%)] text-white border-white/15 placeholder:text-white/40"
                      />
                      <Button
                        type="button"
                        variant="default"
                        className="gap-2 shrink-0"
                        onClick={() => setSearchQuery(search.trim())}
                        disabled={search.trim().length < 2}
                      >
                        <Search className="h-4 w-4" />
                        Search
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="gap-2 shrink-0"
                        onClick={() => {
                          setAsinSyncResult(null);
                          setAsinSyncValue("");
                          setAsinSyncOpen(true);
                        }}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Sync ASIN
                      </Button>
                    </div>
                    <p className="text-xs text-white/50">
                      Type a SKU, ASIN, or title and press Enter (or click Search). Just created a listing? Use Sync ASIN.
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-white/10 text-white hover:bg-white/15 border-white/15">Shipment: {draft.shipmentName}</Badge>
                  <Badge className="bg-white/10 text-white hover:bg-white/15 border-white/15">Selected SKUs: {totalSkus}</Badge>
                  <Badge className="bg-white/10 text-white hover:bg-white/15 border-white/15">Total units: {totalUnits}</Badge>
                </div>

                {inventoryLoading ? (
                  <div className="flex h-[28rem] items-center justify-center rounded-md border border-white/10 bg-[hsl(220,65%,22%)] text-white/70">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Loading inventory…
                  </div>
                ) : (
                  <div ref={productTableScrollRef} className="h-[28rem] overflow-auto rounded-md border border-white/10 bg-shipment-row-alt [overflow-anchor:none] md:h-[32rem]">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-[hsl(220,65%,18%)]">
                        <TableRow className="hover:bg-transparent border-white/10">
                          <TableHead className="text-white font-semibold">Image</TableHead>
                          <TableHead className="text-white font-semibold">SKU</TableHead>
                          <TableHead className="text-white font-semibold">ASIN</TableHead>
                          <TableHead className="text-white font-semibold">Title</TableHead>
                          <TableHead className="text-right text-white font-semibold">Available</TableHead>
                          <TableHead className="w-[160px] text-white font-semibold">Qty to Ship</TableHead>
                          <TableHead className="w-[140px] text-center text-white font-semibold">Save</TableHead>
                          <TableHead className="w-[60px] text-right text-white font-semibold">Remove</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredItems.length === 0 ? (
                          <TableRow className="hover:bg-transparent border-white/10">
                            <TableCell colSpan={8} className="py-10 text-center text-white/70">
                              {searchLoading && searchQuery.trim().length >= 2 ? (
                                <span className="inline-flex items-center justify-center gap-2">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Searching inventory…
                                </span>
                              ) : searchQuery.trim().length >= 2 ? (
                                <>No products match “{searchQuery.trim()}”.</>
                              ) : search.trim().length >= 2 ? (
                                <>Press Enter or click Search to look up “{search.trim()}”.</>
                              ) : (
                                <>Type a SKU, ASIN, or title and press Enter (or click Search) to add products.</>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredItems.map((item, rowIndex) => (
                            <TableRow key={item.id} className={`border-white/10 ${rowIndex % 2 === 0 ? "bg-shipment-row" : "bg-shipment-row-alt"} hover:!bg-shipment-row-hover`}>
                              <TableCell>
                                {item.imageUrl ? (
                                  <img
                                    src={item.imageUrl}
                                    alt={item.title}
                                    className="h-12 w-12 rounded-md border border-white/10 object-contain bg-white"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="flex h-12 w-12 items-center justify-center rounded-md border border-white/10 bg-white/5">
                                    <Package className="h-4 w-4 text-white/50" />
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="font-medium text-white">{item.sku}</TableCell>
                              <TableCell className="font-mono text-xs text-white/70">
                                {item.asin ? (
                                  <div className="inline-flex items-center gap-1.5">
                                    <a
                                      href={`https://www.amazon.com/dp/${item.asin}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-300 hover:text-blue-200 hover:underline"
                                    >
                                      {item.asin}
                                    </a>
                                    <CopyAsinButton asin={item.asin} />
                                  </div>
                                ) : null}
                              </TableCell>
                              <TableCell className="min-w-[260px] text-white/90">{item.title}</TableCell>
                              <TableCell className="text-right text-white/90">{item.availableQty}</TableCell>
                              <TableCell>
                                <Input
                                  type="number"
                                  min="0"
                                  value={item.qtyToShip || ""}
                                  onChange={(event) => updateQtyToShip(item.id, event.target.value)}
                                  placeholder="0"
                                  disabled={!!item.fbaBlocked}
                                  className="bg-[hsl(210,50%,42%)] text-white border-white/15 placeholder:text-white/40 disabled:opacity-50"
                                />
                                {item.fbaBlocked && (
                                  <div className="mt-1 text-[10px] leading-tight text-red-300">
                                    FBA blocked — manufacturer barcode or no valid FNSKU
                                  </div>
                                )}
                                {item.asin && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="mt-1 h-7 text-[11px] bg-transparent text-white/90 border-white/30 hover:bg-white/10"
                                    onClick={() => setPurchaseHistoryAsin({ asin: item.asin!, units: item.qtyToShip || 0 })}
                                    title="View purchase history & allocate units"
                                  >
                                    Purchase history
                                  </Button>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                <div className="flex flex-col items-center gap-1">
                                  {item.savedToShipment === true && item.qtyToShip > 0 ? (
                                    <Badge className="gap-1 bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-500/25">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Saved
                                    </Badge>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="default"
                                      className="gap-1.5"
                                      onClick={() => saveItemRow(item.id)}
                                      disabled={!item.qtyToShip || item.qtyToShip <= 0 || !!item.fbaBlocked}
                                      title="Save this product to the shipment"
                                    >
                                      <Save className="h-3.5 w-3.5" />
                                      Save
                                    </Button>
                                  )}
                                  {item.gatingStatus === "checking" && (
                                    <Badge className="gap-1 bg-white/10 text-white/70 border border-white/20">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Checking approval
                                    </Badge>
                                  )}
                                  {item.gatingStatus === "approved" && (
                                    <Badge
                                      className="gap-1 bg-emerald-500/20 text-emerald-200 border border-emerald-400/40"
                                      title="Amazon confirms this ASIN is ungated for your account."
                                    >
                                      <CheckCircle2 className="h-3 w-3" />
                                      Ungated
                                    </Badge>
                                  )}
                                  {item.gatingStatus === "restricted" && (
                                    <Badge
                                      className="gap-1 bg-red-500/20 text-red-200 border border-red-400/40"
                                      title={item.gatingReason || "Amazon requires approval to list this ASIN in this brand."}
                                    >
                                      <XCircle className="h-3 w-3" />
                                      Approval required
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-white/70 hover:text-red-400 hover:bg-white/10"
                                  onClick={() => removeItemFromShipment(item.id)}
                                  title="Remove from shipment"
                                  aria-label={`Remove ${item.sku} from shipment`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {(() => {
                  const unsavedRows = unsavedShipmentItems;
                  if (unsavedRows.length === 0) return null;
                  return (
                    <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <strong>{unsavedRows.length}</strong> product{unsavedRows.length > 1 ? "s have" : " has"} a quantity entered but {unsavedRows.length > 1 ? "are" : "is"} <strong>not Saved</strong>. They will <em>not</em> be carried into the next steps until you press <strong>Save</strong> on each row.
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          className="gap-1.5"
                          onClick={() => unsavedRows.forEach((it) => saveItemRow(it.id))}
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save all ({unsavedRows.length})
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {(() => {
                  const hasUnsaved = unsavedShipmentItems.length > 0;
                  return (
                    <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
                      <Button
                        onClick={nextFromProducts}
                        className="gap-2"
                        size="lg"
                        disabled={selectedItems.length === 0 || hasUnsaved}
                        title={hasUnsaved ? "Press Save on every product before continuing" : undefined}
                      >
                        Next: Prep
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {draft.step === 3 && (
            <Card className="bg-[hsl(220,65%,22%)] border-white/15 text-white">
              <CardHeader>
                <CardTitle className="text-white">Quantities & Compliance</CardTitle>
                <CardDescription className="text-white/70">Validate quantities, prep, and expiration requirements before building boxes.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {expirationDetectionLoading && (
                  <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                    Checking Amazon catalog signals for expiration-required products…
                  </div>
                )}

                {!canContinueFromCompliance && (
                  <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                    {complianceMissingExpirationItems.length > 0 ? (
                      <div className="space-y-2">
                        <p>
                          Expiration date required for {complianceMissingExpirationItems.length} product{complianceMissingExpirationItems.length > 1 ? "s" : ""}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {complianceMissingExpirationItems.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => scrollToComplianceItem(item.id)}
                              className="underline underline-offset-4"
                            >
                              {item.sku}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p>Make sure every selected product has a quantity greater than 0.</p>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={allComplianceItemsSelected}
                      onCheckedChange={(checked) => toggleAllComplianceSelection(Boolean(checked))}
                      aria-label="Select all products in compliance table"
                    />
                    <div className="text-sm text-muted-foreground">
                      {selectedComplianceItemIds.length} selected of {selectedItems.length}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" type="button" onClick={markAllAsNotRequired} disabled={selectedItems.length === 0}>
                      Mark all as Not required
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={markSelectedAsRequiresExpiration}
                      disabled={selectedComplianceItemIds.length === 0}
                    >
                      Mark selected as Requires expiration
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={syncImagesForSelected}
                      disabled={isSyncingImages || selectedItems.length === 0}
                      title="Pull missing images from Inventory, Created Listings, then Seller Central"
                    >
                      {isSyncingImages
                        ? "Syncing images…"
                        : selectedComplianceItemIds.length > 0
                          ? `Sync images (${selectedComplianceItemIds.length})`
                          : "Sync images for all"}
                    </Button>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                        <TableRow>
                          <TableHead className="w-[72px] text-white font-semibold">Image</TableHead>
                          <TableHead className="text-white font-semibold">SKU</TableHead>
                          <TableHead className="text-white font-semibold">ASIN</TableHead>
                          <TableHead className="text-white font-semibold">Title</TableHead>
                          <TableHead className="text-right text-white font-semibold">Available</TableHead>
                          <TableHead className="w-[160px] text-white font-semibold">Qty to Ship</TableHead>
                          <TableHead className="w-[140px] text-center text-white font-semibold">Save</TableHead>
                          <TableHead className="w-[60px] text-right text-white font-semibold">Remove</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {selectedItems.map((item) => (
                          <TableRow
                            key={item.id}
                            id={`compliance-row-${item.id}`}
                            tabIndex={-1}
                            data-flagged-expiration={flaggedExpirationItemIds.includes(item.id) ? "true" : undefined}
                            className={
                              flaggedExpirationItemIds.includes(item.id)
                                ? "bg-amber-500/15 ring-2 ring-amber-400/70 ring-inset hover:bg-amber-500/20"
                                : undefined
                            }
                          >
                          <TableCell>
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.title}
                                className="h-12 w-12 min-h-12 min-w-12 rounded object-cover border border-white/10"
                                loading="lazy"
                              />
                            ) : (
                              <div className="h-12 w-12 rounded bg-white/5 border border-white/10" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium text-white">{item.sku}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {item.asin ? (
                              <div className="inline-flex items-center gap-1.5">
                                <a
                                  href={`https://www.amazon.com/dp/${item.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {item.asin}
                                </a>
                                <CopyAsinButton asin={item.asin} />
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="min-w-[260px] text-white/90">{item.title}</TableCell>
                          <TableCell className="text-right text-white/90">{item.availableQty}</TableCell>
                          <TableCell className="w-[160px]">
                            <Input
                              type="number"
                              min="0"
                              value={item.qtyToShip || ""}
                              onChange={(event) => updateQtyToShip(item.id, event.target.value)}
                              placeholder="0"
                              disabled={!!item.fbaBlocked}
                              className="bg-[hsl(210,50%,42%)] text-white border-white/15 placeholder:text-white/40 disabled:opacity-50"
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex h-9 items-center justify-center">
                              {item.savedToShipment === true && item.qtyToShip > 0 ? (
                                <Badge className="gap-1 bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-500/25">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Saved
                                </Badge>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="default"
                                  className="gap-1.5"
                                  onClick={() => saveItemRow(item.id)}
                                  disabled={!item.qtyToShip || item.qtyToShip <= 0 || !!item.fbaBlocked}
                                  title="Save this product to the shipment"
                                >
                                  <Save className="h-3.5 w-3.5" />
                                  Save
                                </Button>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-white/70 hover:text-red-400 hover:bg-white/10"
                              onClick={() => removeItemFromShipment(item.id)}
                              title="Remove from shipment"
                              aria-label={`Remove ${item.sku} from shipment`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
                  <Button variant="outline" onClick={() => setCurrentStep(2)} className="gap-2">
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={nextFromCompliance} className="gap-2" size="lg" disabled={!canContinueFromCompliance}>
                    Next: Boxes
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {draft.step === 4 && (
            <Card className="bg-shipment-surface border-white/15 text-white">
              <CardHeader>
                <CardTitle className="text-white">Box Setup</CardTitle>
                <CardDescription className="text-white/70">Define the shipment structure and make sure every box total matches the shipment quantities.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 rounded-lg border border-white/15 bg-shipment-surface p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="box-count" className="text-white font-semibold">Number of Boxes</Label>
                    <Input
                      id="box-count"
                      type="number"
                      min="1"
                      value={draft.numberOfBoxes}
                      disabled
                      readOnly
                      className="bg-white/40 text-[hsl(221,90%,15%)] border-white/30 font-bold text-lg h-11 cursor-not-allowed"
                    />
                    <p className="text-xs text-white/60">Set in Amazon's Send-to-Amazon step.</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/15 bg-white/5 p-3 opacity-80">
                    <div>
                      <p className="font-medium text-white">Identical boxes</p>
                      <p className="text-xs text-white/60">Configured in Amazon when you continue.</p>
                    </div>
                    <Switch
                      checked={draft.numberOfBoxes > 1 && draft.identicalBoxes}
                      disabled
                      onCheckedChange={(checked) => setDraft((current) => ({ ...current, identicalBoxes: checked }))}
                    />
                  </div>
                </div>

                <div className="overflow-x-auto rounded-md border border-white/15 bg-shipment-row-alt">
                    <Table>
                      <TableHeader className="bg-[hsl(220,65%,18%)]">
                        <TableRow className="hover:bg-transparent border-white/10">
                          <TableHead className="w-[72px] text-white font-semibold">Image</TableHead>
                          <TableHead className="text-white font-semibold">SKU</TableHead>
                          <TableHead className="text-white font-semibold">ASIN</TableHead>
                          <TableHead className="text-white font-semibold">Title</TableHead>
                          <TableHead className="text-right text-white font-semibold">Available</TableHead>
                          <TableHead className="w-[160px] text-white font-semibold">Qty to Ship</TableHead>
                          <TableHead className="w-[140px] text-center text-white font-semibold">Save</TableHead>
                          <TableHead className="w-[60px] text-right text-white font-semibold">Remove</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedItems.map((item, rowIndex) => {
                          const rowBg = rowIndex % 2 === 0 ? "bg-shipment-row" : "bg-shipment-row-alt";

                          return (
                            <TableRow key={item.id} id={`box-row-${item.id}`} tabIndex={-1} className={`${rowBg} hover:!bg-shipment-row-hover border-white/10`}>
                              <TableCell>
                                {item.imageUrl ? (
                                  <img
                                    src={item.imageUrl}
                                    alt={item.title}
                                    className="h-12 w-12 min-h-12 min-w-12 rounded object-cover border border-white/10"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="h-12 w-12 rounded bg-white/5 border border-white/10" />
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="font-medium text-white">{item.sku}</div>
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {item.asin ? (
                                  <div className="inline-flex items-center gap-1.5">
                                    <a
                                      href={`https://www.amazon.com/dp/${item.asin}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-primary hover:underline"
                                    >
                                      {item.asin}
                                    </a>
                                    <CopyAsinButton asin={item.asin} />
                                  </div>
                                ) : null}
                              </TableCell>
                              <TableCell className="min-w-[260px] text-white/90">{item.title}</TableCell>
                              <TableCell className="text-right text-white/90">{item.availableQty}</TableCell>
                              <TableCell className="w-[160px]">
                                <Input
                                  type="number"
                                  min="0"
                                  value={item.qtyToShip || ""}
                                  onChange={(event) => updateQtyToShip(item.id, event.target.value)}
                                  placeholder="0"
                                  disabled={!!item.fbaBlocked}
                                  className="bg-[hsl(210,50%,42%)] text-white border-white/15 placeholder:text-white/40 disabled:opacity-50"
                                />
                              </TableCell>
                              <TableCell className="text-center">
                                {item.savedToShipment === true && item.qtyToShip > 0 ? (
                                  <Badge className="gap-1 bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-500/25">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Saved
                                  </Badge>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="default"
                                    className="gap-1.5"
                                    onClick={() => saveItemRow(item.id)}
                                    disabled={!item.qtyToShip || item.qtyToShip <= 0 || !!item.fbaBlocked}
                                    title="Save this product to the shipment"
                                  >
                                    <Save className="h-3.5 w-3.5" />
                                    Save
                                  </Button>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-white/70 hover:text-red-400 hover:bg-white/10"
                                  onClick={() => removeItemFromShipment(item.id)}
                                  title="Remove from shipment"
                                  aria-label={`Remove ${item.sku} from shipment`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                <div className="flex items-center justify-between gap-3">
                  <Button variant="outline" onClick={() => setCurrentStep(2)} className="gap-2">
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={nextFromBoxes} className="gap-2" size="lg" disabled={!canContinueFromBoxes}>
                    Next: Create Inbound Plan
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {draft.step === 5 && (
            <Card className="bg-[hsl(220,65%,22%)] border-white/15 text-white">
              <CardHeader>
                <CardTitle className="text-white">Dimensions & Weight</CardTitle>
                <CardDescription className="text-white/70">Define the physical box data required before you hand off to Amazon.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6 [&_label]:text-white [&_input]:bg-[hsl(210,50%,42%)] [&_input]:text-white [&_input]:border-white/15 [&_input]:placeholder:text-white/40 [&_button[role=combobox]]:bg-[hsl(210,50%,42%)] [&_button[role=combobox]]:text-white [&_button[role=combobox]]:border-white/15 [&_.text-muted-foreground]:text-white/70">
                <div className="rounded-lg border-2 border-amber-400/60 bg-amber-500/15 p-5 text-center">
                  <p className="text-lg font-bold text-amber-100">
                    📐 This step will be set when you Continue to Amazon
                  </p>
                  <p className="mt-2 text-sm text-amber-100/80">
                    Box dimensions and weights are finalized inside Amazon's Send-to-Amazon workflow. Default values shown below.
                  </p>
                </div>
                <fieldset disabled className="space-y-6 opacity-60 pointer-events-none">
                {!canContinueFromDimensions && (
                  <div className="rounded-md border border-white/15 bg-[hsl(220,60%,28%)] p-4 text-sm text-muted-foreground">
                    <div className="space-y-2">
                      {invalidDimensionBoxes.length > 0 ? (
                        <p>Missing dimensions: {invalidDimensionBoxes.join(", ")}</p>
                      ) : null}
                      {invalidWeightBoxes.length > 0 ? (
                        <p>Missing weight: {invalidWeightBoxes.join(", ")}</p>
                      ) : null}
                    </div>
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/15 p-4">
                    <div>
                      <p className="font-medium">Apply same dimensions to all boxes</p>
                      <p className="text-sm text-muted-foreground">Turn off if each box needs its own measurements.</p>
                    </div>
                    <Switch
                      checked={draft.applySameDimensions}
                      onCheckedChange={(checked) => setDraft((current) => ({ ...current, applySameDimensions: checked }))}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/15 p-4">
                    <div>
                      <p className="font-medium">Allow per-box weight</p>
                      <p className="text-sm text-muted-foreground">Keep this off when all boxes share the same weight.</p>
                    </div>
                    <Switch
                      checked={draft.allowPerBoxWeight}
                      onCheckedChange={(checked) => setDraft((current) => ({ ...current, allowPerBoxWeight: checked }))}
                    />
                  </div>
                </div>

                {draft.applySameDimensions ? (
                  <div className="space-y-4 rounded-md border border-white/15 p-4">
                    <div className="grid gap-4 md:grid-cols-5">
                      <div className="space-y-2">
                        <Label>Length</Label>
                        <Input type="number" min="0" value={draft.sameDimensions.length || 27} onChange={(event) => updateSameDimension("length", event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Width</Label>
                        <Input type="number" min="0" value={draft.sameDimensions.width || 17} onChange={(event) => updateSameDimension("width", event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Height</Label>
                        <Input type="number" min="0" value={draft.sameDimensions.height || 15} onChange={(event) => updateSameDimension("height", event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Unit</Label>
                        <Select value={draft.sameDimensions.unit || "in"} onValueChange={(value: DimensionUnit) => updateSameDimension("unit", value)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="in">in</SelectItem>
                            <SelectItem value="cm">cm</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>{draft.allowPerBoxWeight ? "Default weight" : "Weight"}</Label>
                        <div className="flex gap-2">
                          <Input type="number" min="0" value={draft.sameWeight.weight || 50} onChange={(event) => updateSameWeight("weight", event.target.value)} />
                          <Select value={draft.sameWeight.unit || "lb"} onValueChange={(value: WeightUnit) => updateSameWeight("unit", value)}>
                            <SelectTrigger className="w-[92px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="lb">lb</SelectItem>
                              <SelectItem value="kg">kg</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                    {draft.allowPerBoxWeight ? (
                      <div className="space-y-3 border-t border-white/15 pt-4">
                        <div>
                          <p className="font-medium">Per-box weight</p>
                          <p className="text-sm text-muted-foreground">Enter the weight for each box individually.</p>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => (
                            <div key={boxIndex} className="space-y-2 rounded-md border border-white/15 p-3">
                              <Label>Box {boxIndex + 1}</Label>
                              <div className="flex gap-2">
                                <Input
                                  type="number"
                                  min="0"
                                  value={draft.boxWeights[boxIndex]?.weight || ""}
                                  onChange={(event) => updateBoxWeight(boxIndex, "weight", event.target.value)}
                                />
                                <Select
                                  value={draft.boxWeights[boxIndex]?.unit || draft.sameWeight.unit}
                                  onValueChange={(value: WeightUnit) => updateBoxWeight(boxIndex, "unit", value)}
                                >
                                  <SelectTrigger className="w-[92px]"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="lb">lb</SelectItem>
                                    <SelectItem value="kg">kg</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-white/15">
                    <Table>
                      <TableHeader className="bg-[hsl(220,60%,28%)]">
                        <TableRow className="hover:bg-transparent border-white/10">
                          <TableHead className="text-white font-semibold">Box</TableHead>
                          <TableHead className="text-white font-semibold">Length</TableHead>
                          <TableHead className="text-white font-semibold">Width</TableHead>
                          <TableHead className="text-white font-semibold">Height</TableHead>
                          <TableHead className="text-white font-semibold">Dim Unit</TableHead>
                          <TableHead className="text-white font-semibold">Weight</TableHead>
                          <TableHead className="text-white font-semibold">Weight Unit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => (
                          <TableRow key={boxIndex} className="border-white/10 hover:bg-white/5">
                            <TableCell className="font-medium text-white">Box {boxIndex + 1}</TableCell>
                            <TableCell><Input type="number" min="0" value={draft.boxDimensions[boxIndex]?.length || 27} onChange={(event) => updateBoxDimension(boxIndex, "length", event.target.value)} /></TableCell>
                            <TableCell><Input type="number" min="0" value={draft.boxDimensions[boxIndex]?.width || 17} onChange={(event) => updateBoxDimension(boxIndex, "width", event.target.value)} /></TableCell>
                            <TableCell><Input type="number" min="0" value={draft.boxDimensions[boxIndex]?.height || 15} onChange={(event) => updateBoxDimension(boxIndex, "height", event.target.value)} /></TableCell>
                            <TableCell>
                              <Select value={draft.boxDimensions[boxIndex]?.unit || "in"} onValueChange={(value: DimensionUnit) => updateBoxDimension(boxIndex, "unit", value)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="in">in</SelectItem>
                                  <SelectItem value="cm">cm</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                min="0"
                                value={(draft.allowPerBoxWeight ? draft.boxWeights[boxIndex]?.weight : draft.sameWeight.weight) || 50}
                                onChange={(event) =>
                                  draft.allowPerBoxWeight
                                    ? updateBoxWeight(boxIndex, "weight", event.target.value)
                                    : updateSameWeight("weight", event.target.value)
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Select
                                value={draft.allowPerBoxWeight ? draft.boxWeights[boxIndex]?.unit || "lb" : draft.sameWeight.unit}
                                onValueChange={(value: WeightUnit) =>
                                  draft.allowPerBoxWeight ? updateBoxWeight(boxIndex, "unit", value) : updateSameWeight("unit", value)
                                }
                              >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="lb">lb</SelectItem>
                                  <SelectItem value="kg">kg</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                </fieldset>

                <div className="flex items-center justify-between gap-3">
                  <Button variant="outline" onClick={() => setCurrentStep(4)} className="gap-2">
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={nextFromDimensions} className="gap-2" size="lg">
                    Next: Review
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {draft.step === 6 && (
            <div className="space-y-6">
              <Card className="bg-[hsl(220,65%,22%)] border-white/15 text-white">
                <CardHeader>
                  <CardTitle className="text-white">
                    {draft.creationMode === "quantity-only"
                      ? "Create Inbound Plan in Amazon"
                      : "Create Shipment in Amazon"}
                  </CardTitle>
                  <CardDescription className="text-white/70">
                    {draft.creationMode === "quantity-only"
                      ? "Review your SKUs and quantities. Amazon will create an inbound plan only — the actual shipment is finalized in Seller Central (placement, boxes, weights, confirmation)."
                      : "Review the shipment and send it to Amazon so Seller Central opens with the shipment already created."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 lg:grid-cols-[auto_1fr_auto] lg:items-start">
                    <div className="flex flex-wrap items-center gap-3">
                      {hasAmazonCreation ? (
                        <>
                          <Button onClick={handleContinueInAmazon} size="sm" className="gap-2">
                            {draft.creationMode === "quantity-only" && !draft.shipmentId
                              ? "Open Inbound Plan in Seller Central"
                              : "Continue in Amazon Seller Central"}
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                          {draft.inboundPlanId ? (
                            <>
                              <Button
                                onClick={handleCopyInboundPlanId}
                                size="sm"
                                variant="outline"
                                className="gap-2 bg-white/10 text-white border-white/20 hover:bg-white/20 hover:text-white"
                              >
                                <Copy className="h-4 w-4" />
                                Copy Inbound Plan ID
                              </Button>
                              <Button
                                onClick={handleCheckPlanStatus}
                                size="sm"
                                variant="outline"
                                disabled={checkPlanStatusBusy}
                                className="gap-2 bg-white/10 text-white border-white/20 hover:bg-white/20 hover:text-white"
                              >
                                {checkPlanStatusBusy ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4" />
                                )}
                                Check Plan Status
                              </Button>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <Button
                          onClick={createShipmentInAmazon}
                          size="sm"
                          className="gap-2"
                          disabled={shipmentSubmitting || hasAmazonWriteAccessBlocker || !validationChecklist.noMissingData || !draft.shipmentName.trim() || !allPacked}
                          title={!allPacked ? "Check off every item as packed to enable" : undefined}
                        >
                          {shipmentSubmitting ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {draft.creationMode === "quantity-only" ? "Creating inbound plan" : "Creating shipment in Amazon"}
                            </>
                          ) : (
                            <>
                              {draft.creationMode === "quantity-only" ? "Create Inbound Plan in Amazon" : "Create Shipment in Amazon"}
                              <ArrowRight className="h-4 w-4" />
                            </>
                          )}
                        </Button>
                      )}
                      {!hasAmazonCreation && draft.creationMode === "quantity-only" ? (
                        <p className="text-xs text-muted-foreground max-w-xs">
                          This only creates the inbound plan in Amazon (quantities). The actual shipment is finalized in Seller Central — boxes, weights, placement and confirmation happen there.
                        </p>
                      ) : hasAmazonCreation && draft.creationMode === "quantity-only" && !draft.shipmentId ? (
                        <p className="text-xs text-white/70 max-w-md">
                          Inbound plan created. Finish it in Send to Amazon. If Seller Central does not open the plan directly, copy the ID above and paste it into the Send to Amazon search.
                        </p>
                      ) : null}
                    </div>

                    {hasAmazonStatusContent ? (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setAmazonStatusModalOpen(true)}
                          className="gap-2 bg-white/10 text-white border-white/20 hover:bg-white/20 hover:text-white"
                        >
                          View Amazon Status
                        </Button>
                        {draft.inboundPlanId && !draft.shipmentId ? (
                          <Badge variant="secondary">Plan created</Badge>
                        ) : null}
                        {hasAmazonWorkflowWarning ? (
                          <Badge variant="outline" className="text-white border-white/30">Action needed</Badge>
                        ) : null}
                      </div>
                    ) : <div />}

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <Button variant="outline" size="sm" onClick={handleDownloadCsv} className="gap-2">
                        <Download className="h-4 w-4" />
                        Download CSV
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleDownloadExcel} className="gap-2">
                        <FileSpreadsheet className="h-4 w-4" />
                        Download Excel
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleCopySummary} className="gap-2">
                        <ClipboardList className="h-4 w-4" />
                        Copy Summary
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-4">
                    <div className="rounded-md border border-white/15 bg-white/10 p-4">
                      <p className="text-sm text-white/70">Shipment Name</p>
                      <p className="mt-1 font-medium text-white">{draft.shipmentName}</p>
                    </div>
                    <div className="rounded-md border border-white/15 bg-white/10 p-4">
                      <p className="text-sm text-white/70">Total SKUs</p>
                      <p className="mt-1 font-medium text-white">{totalSkus}</p>
                    </div>
                    <div className="rounded-md border border-white/15 bg-white/10 p-4">
                      <p className="text-sm text-white/70">Total Units</p>
                      <p className="mt-1 font-medium text-white">{totalUnits}</p>
                    </div>
                    <div className="rounded-md border border-white/15 bg-white/10 p-4">
                      <p className="text-sm text-white/70">Total Cost (units shipped)</p>
                      <p className="mt-1 font-medium text-white">
                        ${totalCost.toFixed(2)}
                      </p>
                      <p className="mt-1 text-[11px] text-white/60">
                        Sum of unit cost × qty for each SKU, using your COG on record. Missing costs count as $0 — set them on the COG page.
                      </p>
                    </div>
                  </div>


                  <div className="space-y-6">
                    <div className="space-y-6">
                      <div className="rounded-md border border-white/15 bg-white/10 p-4">
                        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-white/20 bg-[hsl(220,65%,22%)]/95 backdrop-blur px-3 py-2 shadow-lg">
                          <div className="flex items-center gap-2 text-sm text-white">
                            <CheckCircle2 className={`h-4 w-4 ${allPacked ? "text-emerald-400" : "text-white/50"}`} />
                            <span className="font-medium">
                              {packVerb} {packRowKeys.filter((k) => packedKeys.has(k)).length} / {packRowKeys.length}
                            </span>
                            {!allPacked && (
                              <span className="text-xs text-white/60">— use ↑ ↓ to navigate, Space to check, or click each item</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => navigatePackRow("up")}
                              disabled={packRowKeys.length === 0}
                              title="Previous item"
                              className="h-8 w-8 bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => navigatePackRow("down")}
                              disabled={packRowKeys.length === 0}
                              title="Next item"
                              className="h-8 w-8 bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setReviewPackOpen(true)}
                              disabled={packRowKeys.length === 0}
                              title="Open full review & pack popup"
                              className="h-8 gap-1.5 bg-emerald-500/20 text-white border-emerald-300/60 hover:bg-emerald-500/30 hover:text-white"
                            >
                              <Eye className="h-4 w-4" />
                              {reviewPackLabel}
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-4">
                          {Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => (
                            <div key={boxIndex} className="space-y-2">
                              {selectedItems.map((item) => {
                                const quantity = draft.identicalBoxes
                                  ? draft.boxQuantities[item.id]?.[0] ?? 0
                                  : draft.boxQuantities[item.id]?.[boxIndex] ?? 0;
                                if (quantity <= 0) return null;
                                const rowKey = `${item.id}-${boxIndex}`;
                                const isPacked = packedKeys.has(rowKey);
                                const isHighlighted = highlightedPackKey === rowKey;
                                const isExpirationFlagged = flaggedExpirationItemIds.includes(item.id);
                                return (
                                  <div
                                    key={rowKey}
                                    ref={(el) => { packRowRefs.current[rowKey] = el; }}
                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                                      isExpirationFlagged
                                        ? "border-amber-400 bg-amber-500/20 ring-2 ring-amber-400/70"
                                        : isHighlighted
                                          ? "border-yellow-300 bg-yellow-300/20 ring-2 ring-yellow-300/60"
                                          : isPacked
                                            ? "border-emerald-400/60 bg-emerald-500/15"
                                            : "border-white/20 bg-shipment-row-alt"
                                    }`}
                                  >
                                    <label
                                      className={`shrink-0 flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer select-none transition-colors ${
                                        isPacked
                                          ? "border-emerald-400 bg-emerald-500/30 text-white"
                                           : "border-white/30 bg-shipment-control text-white/80 hover:bg-shipment-control"
                                      }`}
                                      title={markPackedTitle(isPacked)}
                                    >
                                      <Checkbox
                                        checked={isPacked}
                                        onCheckedChange={() => togglePackedKey(rowKey)}
                                        className="border-white/60 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                                      />
                                      <span className="text-xs font-medium">
                                        {isPacked ? packActionDoneLabel : packActionLabel}
                                      </span>
                                    </label>
                                    {item.imageUrl ? (
                                      <img
                                        src={item.imageUrl}
                                        alt={item.title}
                                        className="h-14 w-14 shrink-0 rounded border object-contain bg-white"
                                      />
                                    ) : (
                                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border bg-muted text-xs text-muted-foreground">
                                        N/A
                                      </div>
                                    )}
                                    <div className="min-w-0 flex-1 leading-snug">
                                      <p className="truncate text-base font-semibold text-white" title={item.title}>
                                        {item.title}
                                      </p>
                                      <p className="text-xs text-white/60">
                                        {item.asin ? (
                                          <a
                                            href={`https://www.amazon.com/dp/${item.asin}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="underline hover:text-white"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            {item.asin}
                                          </a>
                                        ) : (
                                          "—"
                                        )} · {item.sku}
                                      </p>
                                      {(() => {
                                        const unit = costByAsin[(item.asin ?? "").trim()] ?? 0;
                                        const line = unit * quantity;
                                        return (
                                          <p className="text-xs text-white/70">
                                            Unit cost: ${unit.toFixed(2)} · Line: ${line.toFixed(2)}
                                          </p>
                                        );
                                      })()}
                                     </div>
                                    <div className="shrink-0 flex flex-col gap-1.5 w-[200px]">
                                      <Select value={item.prepCategory} onValueChange={(value: PrepValue) => updatePrepCategory(item.id, value)}>
                                        <SelectTrigger className="h-8 bg-shipment-control text-white border-white/30 text-xs">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {PREP_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              {option.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <div className="flex items-center gap-2">
                                        <Switch
                                          checked={item.expirationRequired}
                                          onCheckedChange={(checked) => updateExpirationRequirement(item.id, checked)}
                                          className="data-[state=unchecked]:bg-white/40 border border-white/60 scale-75"
                                        />
                                        <span className="text-[10px] text-white/70">Exp. required</span>
                                      </div>
                                      {item.expirationRequired ? (
                                        <Input
                                          type="date"
                                          value={item.expirationDate}
                                          onChange={(event) => updateExpirationDate(item.id, event.target.value)}
                                          className="h-8 bg-shipment-control text-white border-white/30 text-xs"
                                        />
                                      ) : null}
                                    </div>
                                    <Input
                                      type="text"
                                      inputMode="numeric"
                                      value={quantity || ""}
                                      readOnly
                                      disabled
                                      tabIndex={-1}
                                      title={
                                        draft.inboundPlanId
                                          ? "Cannot change qty — inbound plan already created in Amazon"
                                          : "Units in this box"
                                      }
                                      className="shrink-0 w-20 h-8 bg-shipment-control text-white border-white/30 text-sm tabular-nums text-right cursor-not-allowed disabled:opacity-100"
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => removeItemFromShipment(item.id)}
                                      disabled={Boolean(draft.inboundPlanId)}
                                      title={
                                        draft.inboundPlanId
                                          ? "Cannot remove — inbound plan already created in Amazon"
                                          : "Remove from shipment"
                                      }
                                      className="shrink-0 h-8 w-8 text-white/70 hover:text-white hover:bg-destructive/30"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>


                      {draft.creationMode !== "quantity-only" ? (
                        <div className="rounded-md border p-4">
                          <p className="font-medium">Dimensions</p>
                          <div className="mt-4 space-y-3 text-sm">
                            {draft.applySameDimensions ? (
                              <div className="flex flex-wrap items-center gap-3">
                                <Badge variant="secondary">
                                  {draft.sameDimensions.length} × {draft.sameDimensions.width} × {draft.sameDimensions.height} {draft.sameDimensions.unit}
                                </Badge>
                                <Badge variant="secondary">
                                  {draft.sameWeight.weight} {draft.sameWeight.unit}
                                </Badge>
                              </div>
                            ) : (
                              draft.boxDimensions.map((dimension, boxIndex) => {
                                const weight = draft.allowPerBoxWeight ? draft.boxWeights[boxIndex] : draft.sameWeight;
                                return (
                                  <div key={boxIndex} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
                                    <span className="font-medium">Box {boxIndex + 1}</span>
                                    <span>
                                      {dimension.length} × {dimension.width} × {dimension.height} {dimension.unit}
                                    </span>
                                    <span>{weight.weight} {weight.unit}</span>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>

                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <Button variant="outline" onClick={() => setCurrentStep(4)} className="gap-2">
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </main>

      <Dialog open={reviewPackOpen} onOpenChange={setReviewPackOpen}>
        <DialogContent className="w-[96vw] max-w-[1400px] sm:max-w-[1400px] bg-[hsl(220,65%,22%)] border-white/20 text-white p-0 overflow-hidden">
          <DialogHeader className="px-6 pt-5 pb-4 border-b border-white/15">
            <DialogTitle className="sr-only">{reviewPackLabel}</DialogTitle>
            <DialogDescription className="sr-only">
              Edits, deletes, and packed checks here update the shipment instantly. Use ↑ ↓ to navigate, Space to check.
            </DialogDescription>
            {(() => {
              const highlightedItem = highlightedPackKey
                ? selectedItems.find((it) => `${it.id}-0` === highlightedPackKey || highlightedPackKey.startsWith(`${it.id}-`))
                : null;
              return (
                <div className="flex flex-wrap items-center gap-5">
                  {highlightedItem?.imageUrl ? (
                    <div className="h-32 w-32 sm:h-40 sm:w-40 shrink-0 rounded-lg border border-white/20 bg-white p-2 shadow-md overflow-hidden">
                      <img
                        src={highlightedItem.imageUrl}
                        alt={highlightedItem.title}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex h-32 w-32 sm:h-40 sm:w-40 shrink-0 items-center justify-center rounded-lg border border-dashed border-white/30 bg-white/5 text-xs text-white/50 shadow-inner">
                      {highlightedItem ? "No image" : "No selection"}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    {highlightedItem ? (
                      <>
                        <p className="text-lg sm:text-2xl font-bold text-white leading-tight break-words" title={highlightedItem.title}>
                          {highlightedItem.title}
                        </p>
                        <p className="mt-1 text-sm text-white/70">
                          {highlightedItem.asin || "—"} · {highlightedItem.sku}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-white/60">
                        Click any row (or use ↑ ↓) to preview the item here. Space to mark packed.
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </DialogHeader>
          <div className="flex flex-col max-h-[80vh]">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/15 bg-[hsl(220,65%,22%)]/95 backdrop-blur px-6 py-3">
              <div className="flex items-center gap-3 text-sm">
                <CheckCircle2 className={`h-4 w-4 ${allPacked ? "text-emerald-400" : "text-white/50"}`} />
                <span className="font-medium">
                  {packVerb} {packRowKeys.filter((k) => packedKeys.has(k)).length} / {packRowKeys.length}
                </span>
                {!allPacked && (
                  <span className="text-xs text-white/60">— ↑ ↓ to navigate, Space to check</span>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setReviewPackOpen(false)}
                  className="ml-2 h-7 bg-emerald-500 hover:bg-emerald-600 text-white"
                >
                  Done
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => navigatePackRow("up")}
                  disabled={packRowKeys.length === 0}
                  title="Previous item"
                  className="h-8 w-8 bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => navigatePackRow("down")}
                  disabled={packRowKeys.length === 0}
                  title="Next item"
                  className="h-8 w-8 bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="overflow-y-auto px-6 py-4 space-y-4">
              {Array.from({ length: draft.numberOfBoxes }, (_, boxIndex) => (
                <div key={boxIndex} className="space-y-2">
                  {draft.numberOfBoxes > 1 && (
                    <p className="text-xs uppercase tracking-wide text-white/50">Box {boxIndex + 1}</p>
                  )}
                  {selectedItems.map((item) => {
                    const quantity = draft.identicalBoxes
                      ? draft.boxQuantities[item.id]?.[0] ?? 0
                      : draft.boxQuantities[item.id]?.[boxIndex] ?? 0;
                    if (quantity <= 0) return null;
                    const rowKey = `${item.id}-${boxIndex}`;
                    const isPacked = packedKeys.has(rowKey);
                    const isHighlighted = highlightedPackKey === rowKey;
                    return (
                      <div
                        key={rowKey}
                        ref={(el) => { dialogPackRowRefs.current[rowKey] = el; }}
                        onClick={() => setHighlightedPackKey(rowKey)}
                        className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 transition-colors cursor-pointer ${
                          isHighlighted
                            ? "border-yellow-300 bg-yellow-300/20 ring-2 ring-yellow-300/60"
                            : isPacked
                              ? "border-emerald-400/60 bg-emerald-500/15"
                              : "border-white/20 bg-shipment-row-alt"
                        }`}
                      >
                        <label
                          onClick={(e) => e.stopPropagation()}
                          className={`shrink-0 flex items-center gap-1.5 rounded-md border px-1.5 py-1 cursor-pointer select-none transition-colors ${
                            isPacked
                              ? "border-emerald-400 bg-emerald-500/30 text-white"
                              : "border-white/30 bg-shipment-control text-white/80 hover:bg-shipment-control"
                          }`}
                          title={markPackedTitle(isPacked)}
                        >
                          <Checkbox
                            checked={isPacked}
                            onCheckedChange={() => togglePackedKey(rowKey)}
                            className="border-white/60 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                          />
                          <span className="text-xs font-medium">
                            {isPacked ? packActionDoneLabel : packActionLabel}
                          </span>
                        </label>
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="h-9 w-9 shrink-0 rounded border object-contain bg-white"
                          />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground">
                            N/A
                          </div>
                        )}
                        <div className="min-w-0 flex-1 leading-tight">
                          <p className="break-words text-xs font-medium text-white" title={item.title}>
                            {item.title}
                          </p>
                          <p className="truncate text-[10px] text-white/60">
                            {item.asin || "—"} · {item.sku}
                          </p>
                        </div>
                        <div className="shrink-0 flex flex-col gap-1 w-[140px]" onClick={(e) => e.stopPropagation()}>
                          <Select value={item.prepCategory} onValueChange={(value: PrepValue) => updatePrepCategory(item.id, value)}>
                            <SelectTrigger className="h-7 bg-shipment-control text-white border-white/30 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PREP_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <div className="flex items-center gap-1.5">
                            <Switch
                              checked={item.expirationRequired}
                              onCheckedChange={(checked) => updateExpirationRequirement(item.id, checked)}
                              className="data-[state=unchecked]:bg-white/40 border border-white/60 scale-75"
                            />
                            <span className="text-[10px] text-white/70">Exp.</span>
                            {item.expirationRequired ? (
                              <Input
                                type="date"
                                value={item.expirationDate}
                                onChange={(event) => updateExpirationDate(item.id, event.target.value)}
                                className="h-6 flex-1 px-1 bg-shipment-control border-white/30 text-white text-[10px]"
                              />
                            ) : null}
                          </div>
                        </div>
                        <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Label className="text-[10px] text-white/60">Qty</Label>
                          <Input
                            type="text"
                            inputMode="numeric"
                            value={quantity}
                            readOnly
                            disabled
                            tabIndex={-1}
                            className="h-7 w-16 px-1 bg-shipment-control border-white/30 text-white text-center text-xs cursor-not-allowed disabled:opacity-100"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); removeItemFromShipment(item.id); }}
                          disabled={Boolean(draft.inboundPlanId)}
                          title={
                            draft.inboundPlanId
                              ? "Cannot remove — inbound plan already created in Amazon"
                              : "Remove from shipment"
                          }
                          className="shrink-0 h-7 w-7 text-white/70 hover:text-white hover:bg-destructive/30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ))}
              {packRowKeys.length === 0 && (
                <p className="text-sm text-white/60 text-center py-8">No items to review.</p>
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-white/15 bg-[hsl(220,65%,22%)] px-6 py-3">
              <span className="text-xs text-white/60">
                {allPacked ? allPackedDoneLabel : leftToPackLabel(packRowKeys.length - packRowKeys.filter((k) => packedKeys.has(k)).length)}
              </span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={amazonStatusModalOpen} onOpenChange={setAmazonStatusModalOpen}>
        <DialogContent className="w-[96vw] max-w-[900px] sm:max-w-[900px] bg-[hsl(220,65%,22%)] border-white/20 text-white max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white">Amazon Status</DialogTitle>
            <DialogDescription className="text-white/70">
              Plan IDs, shipment IDs, and any Amazon workflow messages for this shipment.
            </DialogDescription>
          </DialogHeader>
          <div className="text-white [&_p.text-muted-foreground]:text-white/70 [&_.text-muted-foreground]:text-white/70">
            {amazonStatusPanel}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeDialogOpen} onOpenChange={setMergeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge drafts</DialogTitle>
            <DialogDescription>Select the drafts below and create the new merged draft name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">Selected drafts</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedDraftsForMerge.map((entry) => (
                  <Badge key={entry.id} variant="outline">{entry.shipmentName || "Untitled shipment"}</Badge>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="merge-name">New shipment name</Label>
              <Input id="merge-name" value={mergeName} onChange={(event) => setMergeName(event.target.value)} placeholder="Bassam + Bassam2" />
            </div>
            <div className="rounded-md border p-4 text-sm text-muted-foreground">
              Products with the same SKU will be combined, and the merged draft will reopen at Box Setup so you can rebuild boxes safely.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeDialogOpen(false)}>Cancel</Button>
            <Button onClick={mergeSelectedDrafts} disabled={selectedDraftsForMerge.length < 2 || !mergeName.trim()} className="gap-2">
              <Layers3 className="h-4 w-4" />
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameDialogEntry)} onOpenChange={(open) => { if (!open) { setRenameDialogEntry(null); setRenameValue(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename draft</DialogTitle>
            <DialogDescription>Update the shipment draft name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-draft">Shipment name</Label>
            <Input id="rename-draft" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Shipment name" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRenameDialogEntry(null); setRenameValue(""); }}>Cancel</Button>
            <Button onClick={confirmRenameShipment} disabled={!renameValue.trim()}>
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(planStatusDialog?.open)}
        onOpenChange={(open) => {
          if (!open) setPlanStatusDialog((prev) => (prev ? { ...prev, open: false } : prev));
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Inbound Plan Status
              {planStatusDialog ? (
                <Badge
                  variant={
                    planStatusDialog.status === "ERROR" || planStatusDialog.status === "ERRORED"
                      ? "destructive"
                      : ["ACTIVE", "SHIPPED", "RECEIVING", "CLOSED"].includes(planStatusDialog.status)
                        ? "default"
                        : "secondary"
                  }
                >
                  {planStatusDialog.status}
                </Badge>
              ) : null}
            </DialogTitle>
            <DialogDescription>
              Live response from Amazon SP-API for this Inbound Plan.
            </DialogDescription>
          </DialogHeader>
          {planStatusDialog ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3">
                <p className="text-muted-foreground text-xs">Inbound Plan ID</p>
                <p className="mt-1 font-medium break-all">{planStatusDialog.inboundPlanId}</p>
              </div>

              {planStatusDialog.error ? (
                <div className="space-y-2">
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
                    <p className="font-medium text-destructive">Amazon error</p>
                    <p className="mt-1 text-destructive/90 break-words">{planStatusDialog.error}</p>
                    {planStatusDialog.httpStatus ? (
                      <p className="mt-1 text-xs text-muted-foreground">HTTP {planStatusDialog.httpStatus}</p>
                    ) : null}
                  </div>
                  {Array.isArray(planStatusDialog.operationErrors) && planStatusDialog.operationErrors.length > 0 ? (
                    <div className="rounded-md border p-3 space-y-3">
                      <p className="text-xs text-muted-foreground">Failed operations from Amazon</p>
                      {planStatusDialog.operationErrors.map((opErr, idx) => (
                        <div key={idx} className="space-y-1">
                          <p className="text-sm font-medium">
                            {opErr.operation}{" "}
                            <span className="text-xs text-muted-foreground">({opErr.status})</span>
                          </p>
                          <ul className="ml-4 list-disc space-y-1 text-sm text-foreground/90">
                            {opErr.messages.map((m, mi) => (
                              <li key={mi} className="break-words">{m}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-md border p-3">
                      <p className="text-muted-foreground text-xs">Status</p>
                      <p className="mt-1 font-medium">{planStatusDialog.status}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-muted-foreground text-xs">Confirmed shipments</p>
                      <p className="mt-1 font-medium">{planStatusDialog.shipmentsCount}</p>
                    </div>
                  </div>

                  <div className="rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">Shipment IDs</p>
                    {planStatusDialog.shipmentIds.length > 0 ? (
                      <div className="mt-1 space-y-1">
                        {planStatusDialog.shipmentIds.map((sid) => (
                          <p key={sid} className="font-medium break-all">{sid}</p>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-muted-foreground">
                        No confirmed shipments yet — finish placement, boxes & weights in Send to Amazon.
                      </p>
                    )}
                  </div>

                  {Array.isArray(planStatusDialog.destinationMarketplaces) && planStatusDialog.destinationMarketplaces.length > 0 ? (
                    <div className="rounded-md border p-3">
                      <p className="text-muted-foreground text-xs">Destination marketplaces</p>
                      <p className="mt-1 font-medium break-all">
                        {planStatusDialog.destinationMarketplaces
                          .map((m) => (typeof m === "string" ? m : (m as { marketplaceId?: string })?.marketplaceId ?? JSON.stringify(m)))
                          .join(", ")}
                      </p>
                    </div>
                  ) : null}
                </>
              )}

              <p className="text-xs text-muted-foreground">
                Checked {new Date(planStatusDialog.fetchedAt).toLocaleString()}
              </p>
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={handleCheckPlanStatus}
              disabled={checkPlanStatusBusy}
              className="gap-2"
            >
              {checkPlanStatusBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button onClick={() => setPlanStatusDialog((prev) => (prev ? { ...prev, open: false } : prev))}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={asinSyncOpen} onOpenChange={(open) => {
        if (asinSyncBusy) return;
        setAsinSyncOpen(open);
        if (!open) {
          setAsinSyncSku("");
          setAsinSyncResult(null);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sync ASIN from Amazon</DialogTitle>
            <DialogDescription>
              Just created a new listing? Enter the ASIN (and optional SKU) to fetch live inventory from Amazon and add it to this shipment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="asin-sync-input">ASIN</Label>
              <Input
                id="asin-sync-input"
                value={asinSyncValue}
                onChange={(e) => setAsinSyncValue(e.target.value)}
                placeholder="e.g. B01H0XM5D4"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !asinSyncBusy) {
                    e.preventDefault();
                    void handleAsinSync();
                  }
                }}
                disabled={asinSyncBusy}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="asin-sync-sku-input">
                SKU <span className="text-xs text-muted-foreground">(optional — use to target a specific listing)</span>
              </Label>
              <Input
                id="asin-sync-sku-input"
                value={asinSyncSku}
                onChange={(e) => setAsinSyncSku(e.target.value)}
                placeholder="Leave empty to auto-detect"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !asinSyncBusy) {
                    e.preventDefault();
                    void handleAsinSync();
                  }
                }}
                disabled={asinSyncBusy}
              />
              <p className="text-xs text-muted-foreground">
                If multiple SKUs share this ASIN (e.g. duplicate or wrong listing), enter the exact SKU to sync only that one.
              </p>
            </div>

            {asinSyncResult?.ok === true ? (
              <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                <p className="font-medium text-green-700 dark:text-green-300">Synced successfully</p>
                <div className="mt-2 flex items-start gap-3">
                  {asinSyncResult.imageUrl ? (
                    <img
                      src={asinSyncResult.imageUrl}
                      alt={asinSyncResult.title}
                      className="h-14 w-14 shrink-0 rounded-md border border-border object-cover"
                      loading="lazy"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <p className="text-foreground">{asinSyncResult.title}</p>
                    <p className="text-xs text-muted-foreground">
                      ASIN {asinSyncResult.asin} · SKU {asinSyncResult.sku} · Available {asinSyncResult.available}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Added to your inventory list — close this dialog and set Qty to Ship.
                </p>
              </div>
            ) : null}

            {asinSyncResult?.ok === false ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {asinSyncResult.message}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setAsinSyncOpen(false)}
              disabled={asinSyncBusy}
            >
              Close
            </Button>
            <Button onClick={handleAsinSync} disabled={asinSyncBusy || !asinSyncValue.trim()} className="gap-2">
              {asinSyncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {asinSyncBusy ? "Syncing…" : "Sync ASIN"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {purchaseHistoryAsin && (
        <PurchaseHistoryDialog
          open={!!purchaseHistoryAsin}
          onOpenChange={(o) => { if (!o) setPurchaseHistoryAsin(null); }}
          asin={purchaseHistoryAsin.asin}
          draftId={draft.id}
          shipmentId={draft.shipmentId ?? null}
          defaultUnitsToShip={purchaseHistoryAsin.units}
        />
      )}

    </div>
  );
}
