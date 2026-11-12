import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { isAmazonNotConnected, AMAZON_CONNECT_MESSAGE } from "@/lib/amazonConnection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Package, DollarSign, Plus, X, ShieldCheck, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Navbar from "@/components/Navbar";
import { useNavigate } from "react-router-dom";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { generateSKU } from "@/utils/skuGenerator";
import ListingIssuesPanel from "@/components/listing/ListingIssuesPanel";
import RiskChecksPanel from "@/components/listing/RiskChecksPanel";
import { usePageFavicon } from "@/hooks/use-page-favicon";
import { useFbaEligibility } from "@/hooks/use-fba-eligibility";
import { FbaReadinessTracker } from "@/components/fba/FbaReadinessTracker";

interface SupplierLink {
  link: string;
  discount_code: string;
}

interface MarketplaceGating {
  marketplace: string;
  marketplaceId: string;
  name: string;
  flag: string;
  status: string;
  reasons: string[];
}

const MARKETPLACE_FLAGS: Record<string, string> = {
  US: '🇺🇸', CA: '🇨🇦', MX: '🇲🇽', BR: '🇧🇷',
  UK: '🇬🇧', DE: '🇩🇪', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱',
  AU: '🇦🇺', JP: '🇯🇵', IN: '🇮🇳', SG: '🇸🇬', AE: '🇦🇪', SA: '🇸🇦', TR: '🇹🇷', EG: '🇪🇬',
};

const SELLER_CENTRAL_DOMAINS: Record<string, string> = {
  US: 'sellercentral.amazon.com', UK: 'sellercentral.amazon.co.uk', DE: 'sellercentral.amazon.de',
  ES: 'sellercentral.amazon.es', CA: 'sellercentral.amazon.ca', MX: 'sellercentral.amazon.com.mx',
  BR: 'sellercentral.amazon.com.br', FR: 'sellercentral.amazon.fr', IT: 'sellercentral.amazon.it',
  NL: 'sellercentral.amazon.nl', SE: 'sellercentral.amazon.se', PL: 'sellercentral.amazon.pl',
  AU: 'sellercentral.amazon.com.au', JP: 'sellercentral.amazon.co.jp', IN: 'sellercentral.amazon.in',
  SG: 'sellercentral.amazon.sg', AE: 'sellercentral.amazon.ae', SA: 'sellercentral.amazon.sa',
  TR: 'sellercentral.amazon.com.tr', EG: 'sellercentral.amazon.eg',
};

const approvalUrlFor = (asin: string, marketplace: string) => {
  const domain = SELLER_CENTRAL_DOMAINS[marketplace] || SELLER_CENTRAL_DOMAINS.US;
  return `https://${domain}/hz/approvalrequest/restrictions/approve?asin=${asin.toUpperCase()}&itemcondition=new&ref_=xx_addlisting_dnav_xx`;
};

const CreateListing = () => {
  const { user } = useAuth();
  usePageFavicon("Cr");
  const { toast } = useToast();
  const navigate = useNavigate();
  
  // Product fetching state
  const [asin, setAsin] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [productData, setProductData] = useState<{
    title: string;
    imageUrl: string;
    price: number | null;
    fees: any;
    gatingStatus?: string;
    gatingReasons?: string[];
    marketplaceGating?: MarketplaceGating[];
  } | null>(null);
  
  // Listing creation state
  const [sku, setSku] = useState("");
  const [totalCostInput, setTotalCostInput] = useState(""); // Total Cost - user enters
  const [units, setUnits] = useState("1");
  const [sellingPrice, setSellingPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [condition, setCondition] = useState("new_new");
  const [fulfillmentChannel, setFulfillmentChannel] = useState("FBA");
  const [supplierLinks, setSupplierLinks] = useState<SupplierLink[]>([
    { link: "", discount_code: "" }
  ]);
  const [isCreating, setIsCreating] = useState(false);
  const [createMode, setCreateMode] = useState<"amazon" | "database">("amazon");
  const [isValidating, setIsValidating] = useState(false);
  const [validationIssues, setValidationIssues] = useState<any[] | null>(null);
  const [validationStatus, setValidationStatus] = useState<string | undefined>();
  const [validationMode, setValidationMode] = useState<string | undefined>();
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [detectedBrand, setDetectedBrand] = useState<string | null>(null);
  const [isGenericBrand, setIsGenericBrand] = useState(false);
  const [userMarketplaces, setUserMarketplaces] = useState<string[]>(['US']);
  const [primaryMarketplace, setPrimaryMarketplace] = useState<string>('US');
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>('US');
  const [isAdmin, setIsAdmin] = useState(false);

  // Centralized FBA eligibility gate (shared with extension, Add Purchase, Print, Shipment Builder).
  const fbaElig = useFbaEligibility({
    asin: /^[A-Z0-9]{10}$/i.test(asin) && productData ? asin.toUpperCase() : undefined,
    marketplace: selectedMarketplace,
    condition,
    enabled: !!productData,
  });
  const fbaBlocked = !!fbaElig.data && fbaElig.data.eligible === false;
  const sellabilityStage = fbaElig.data?.stageStatuses?.find(stage => stage.stage === "sellability");
  const selectedMarketplaceGate = productData?.marketplaceGating?.find(mp => mp.marketplace === selectedMarketplace);
  const selectedMarketplaceStatus = selectedMarketplaceGate?.status || productData?.gatingStatus;
  const selectedMarketplaceApproved = selectedMarketplaceStatus === "APPROVED" || selectedMarketplaceStatus === "ELIGIBLE";
  const selectedMarketplaceGated = selectedMarketplaceStatus === "APPROVAL_REQUIRED" || selectedMarketplaceStatus === "RESTRICTED";
  const fbaHardGate = fbaBlocked || selectedMarketplaceGated;

  const showFbaBlockedToast = (reason?: string | null) => {
    toast({
      title: "FBA blocked for this ASIN",
      description: reason || "Amazon may reject this ASIN for FBA. Use FBM and Save to Database only, or fix the barcode/FNSKU in Seller Central and re-check.",
      variant: "destructive",
    });
  };

  const showFbaUnconfirmedToast = (reason?: string | null) => {
    toast({
      title: "Approval not confirmed",
      description: reason || "No SP-API restriction returned — verify on Amazon. Approval may still be required at listing time.",
    });
  };

  const runRequiredFbaGate = async () => {
    if (!productData || !/^[A-Z0-9]{10}$/i.test(asin)) return null;
    const eligibility = await fbaElig.recheck();
    if (!eligibility) {
      toast({
        title: "FBA eligibility check failed",
        description: "Listing creation was stopped because FBA eligibility could not be verified.",
        variant: "destructive",
      });
      return null;
    }
    const selectedGate = productData?.marketplaceGating?.find(mp => mp.marketplace === selectedMarketplace);
    const marketplaceStatus = selectedGate?.status || productData?.gatingStatus;
    const marketplaceApproved = marketplaceStatus === "APPROVED" || marketplaceStatus === "ELIGIBLE";
    if (eligibility.eligible === false) {
      if (fulfillmentChannel === "FBA" || createMode === "amazon") {
        setFulfillmentChannel("FBM");
        setCreateMode("database");
      }
      showFbaBlockedToast(eligibility.fba_block_reason);
    } else if (!marketplaceApproved && marketplaceStatus === "APPROVAL_REQUIRED") {
      if (fulfillmentChannel === "FBA" || createMode === "amazon") {
        setFulfillmentChannel("FBM");
        setCreateMode("database");
      }
      showFbaUnconfirmedToast("Amazon returned an approval-required restriction for New condition in this marketplace.");
    }
    return eligibility;
  };

  // Auto-switch to FBM if blocked or Amazon approval is unconfirmed.
  useEffect(() => {
    if (fbaHardGate && fulfillmentChannel === "FBA") {
      setFulfillmentChannel("FBM");
      setCreateMode("database");
    }
  }, [fbaHardGate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check admin role
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  // Detect user's authorized marketplaces + load/save primary_marketplace_id
  useEffect(() => {
    if (!user) return;
    const detect = async () => {
      try {
        const { getMarketplaceFromId } = await import("@/lib/marketplaceCurrency");
        
        // Fetch authorizations and stored primary in parallel
        const [authRes, profileRes] = await Promise.all([
          supabase
            .from("seller_authorizations")
            .select("marketplace_id, created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: true }),
          supabase
            .from("profiles")
            .select("primary_marketplace_id")
            .eq("id", user.id)
            .maybeSingle(),
        ]);

        if (authRes.data && authRes.data.length > 0) {
          const codes = authRes.data.map((r: any) => getMarketplaceFromId(r.marketplace_id));
          const uniqueCodes = [...new Set(codes)];
          setUserMarketplaces(uniqueCodes);

          // Use stored primary if it exists and is still connected, otherwise auto-detect
          const storedPrimary = profileRes.data?.primary_marketplace_id as string | null;
          let resolvedPrimary: string;

          if (storedPrimary && uniqueCodes.includes(storedPrimary)) {
            resolvedPrimary = storedPrimary;
          } else {
            // First connected marketplace = initial default
            resolvedPrimary = getMarketplaceFromId(authRes.data[0].marketplace_id);
            // Save it to profiles so it persists
            await supabase
              .from("profiles")
              .update({ primary_marketplace_id: resolvedPrimary } as any)
              .eq("id", user.id);
          }

          setPrimaryMarketplace(resolvedPrimary);
          setSelectedMarketplace(resolvedPrimary);
        }
      } catch (e) {
        console.warn("Could not detect user marketplaces:", e);
      }
    };
    detect();
  }, [user]);

  // Auto-generate SKU when component mounts
  useEffect(() => {
    setSku(generateSKU());
  }, []);

  const fetchProductData = async () => {
    if (!asin) {
      toast({
        title: "Error",
        description: "Please enter an ASIN",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsFetching(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data, error } = await supabase.functions.invoke(
        'fetch-listing-snapshot',
        {
          body: { asin: asin.toUpperCase() },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (error) {
        const msg = error.message || "";

        // See src/lib/amazonConnection.ts -- supabase-js hides the 409 body on
        // error.context, so error.message alone cannot tell us this happened.
        if (await isAmazonNotConnected(error)) {
          toast({
            title: "Amazon account not connected",
            description: AMAZON_CONNECT_MESSAGE,
            variant: "destructive",
          });
          return;
        }

        if (msg.includes("NOT_FOUND")) {
          toast({
            title: "ASIN not found",
            description: "Amazon could not find this ASIN in the US marketplace. You can still continue by entering the price manually.",
            variant: "destructive",
          });
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast({
            title: "Amazon quota exceeded",
            description: "We hit the SP-API rate limit while fetching product data. Please try again later or enter the price manually.",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Error",
          description: "Failed to fetch product data: " + msg,
          variant: "destructive",
        });
        return;
      }

      // Check for error responses returned as data (with 200 status)
      if (data?.error) {
        if (data.error === 'AMAZON_INTERNAL_ERROR') {
          toast({
            title: "Amazon Temporarily Unavailable",
            description: "Amazon's servers are experiencing issues. Please try again in a few seconds.",
            variant: "destructive",
          });
          return;
        }

        if (data.error === 'QUOTA_EXCEEDED') {
          toast({
            title: "Amazon quota exceeded",
            description: "We hit the SP-API rate limit. Please try again later or enter the price manually.",
            variant: "destructive",
          });
          return;
        }

        if (data.error === 'NOT_FOUND' || data.notFound) {
          toast({
            title: "ASIN not found",
            description: "Amazon could not find this ASIN. You can still continue by entering the price manually.",
            variant: "destructive",
          });
          return;
        }
      }

      if (!data) {
        toast({
          title: "Error",
          description: "No product data returned from Amazon.",
          variant: "destructive",
        });
        return;
      }

      setProductData({
        title: data.title || "Unknown Product",
        imageUrl: data.imageUrl || "",
        price: data.price || null,
        fees: data.fees || null,
        gatingStatus: data.gatingStatus || 'UNKNOWN',
        gatingReasons: data.gatingReasons || [],
        marketplaceGating: data.marketplaceGating || []
      });

      // Set selling price from Amazon
      if (data.price) {
        setSellingPrice(data.price.toString());
      }

      toast({
        title: "Success",
        description: "Product data retrieved successfully",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to fetch product data: " + error.message,
        variant: "destructive",
      });
    } finally {
      setIsFetching(false);
    }
  };

  const addSupplierLink = () => {
    setSupplierLinks([...supplierLinks, { link: "", discount_code: "" }]);
  };

  const removeSupplierLink = (index: number) => {
    setSupplierLinks(supplierLinks.filter((_, i) => i !== index));
  };

  const updateSupplierLink = (index: number, field: keyof SupplierLink, value: string) => {
    const newLinks = [...supplierLinks];
    newLinks[index][field] = value;
    setSupplierLinks(newLinks);
  };

  // Calculate COG (unit cost) from totalCost / units
  const calculateCOG = (): number => {
    const totalCostNum = parseFloat(totalCostInput) || 0;
    const unitsNum = parseInt(units) || 1;
    return unitsNum > 0 ? totalCostNum / unitsNum : 0;
  };

  const createListing = async () => {
    const totalCostNum = parseFloat(totalCostInput);
    const unitsNum = parseInt(units) || 1;
    
    // Validation
    if (!productData || !sku || !sellingPrice) {
      toast({
        title: "Missing Information",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }
    
    if (!totalCostInput || isNaN(totalCostNum) || totalCostNum <= 0) {
      toast({
        title: "Invalid Total Cost",
        description: "Total Cost must be greater than 0",
        variant: "destructive",
      });
      return;
    }
    
    if (unitsNum < 1) {
      toast({
        title: "Invalid Units",
        description: "Units must be at least 1",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsCreating(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Hard client-side gate: every New Listing create/save action must check
      // the central FBA eligibility service immediately before doing anything.
      const eligibility = await runRequiredFbaGate();
      if (!eligibility) return;
      const blockedNow = eligibility.eligible === false;
      const selectedGate = productData?.marketplaceGating?.find(mp => mp.marketplace === selectedMarketplace);
      const marketplaceStatus = selectedGate?.status || productData?.gatingStatus;
      const gatedNow = blockedNow || marketplaceStatus === "APPROVAL_REQUIRED" || marketplaceStatus === "RESTRICTED";
      const saveAsFbmOnly = gatedNow && createMode === "database" && fulfillmentChannel === "FBM";
      if (gatedNow && !saveAsFbmOnly) return;
      const shouldCreateOnAmazon = createMode === "amazon" && !gatedNow;

      // Calculate COG (unit cost)
      const cogNum = unitsNum > 0 ? totalCostNum / unitsNum : totalCostNum;

      // Get FNSKU from fnsku_map if available
      const { data: fnskuData } = await supabase
        .from("fnsku_map")
        .select("fnsku")
        .eq("asin", asin.toUpperCase())
        .maybeSingle();

      // Save to created_listings table
      const filteredSupplierLinks = supplierLinks.filter(s => s.link.trim() !== "");
      
      // Set date_created to today's date in YYYY-MM-DD format
      const today = new Date();
      const dateCreated = today.toISOString().split('T')[0]; // Format: YYYY-MM-DD
      
      // Phase C2: FBA listings being submitted to Amazon enter PENDING_VALIDATION.
      // The validation worker promotes them to ACTIVE once Amazon propagates an
      // FNSKU. FBM listings (and FBA rows the user is just tracking locally
      // without submitting to Amazon) stay ACTIVE so existing flows are unchanged.
      const willSubmitToAmazon = shouldCreateOnAmazon && fulfillmentChannel === 'FBA';
      const initialValidationStatus = willSubmitToAmazon ? 'PENDING_VALIDATION' : 'ACTIVE';

      // Repurchase check: if this ASIN already has a created_listings row,
      // update it with a weighted-average cost (same behavior as the Excel
      // bulk-import path in CreatedListings.tsx) instead of inserting a
      // second, independent row. A duplicate row would make Inventory
      // Valuation's "newest row wins" cost resolution jump to whatever this
      // one purchase cost, discarding the weighted history.
      const { data: existingRow, error: existingRowError } = await supabase
        .from("created_listings")
        .select("id, cost, units")
        .eq("user_id", user?.id!)
        .eq("asin", asin.toUpperCase())
        .maybeSingle();

      if (existingRowError) {
        console.error("Existing listing lookup error:", existingRowError);
        toast({
          title: "Error",
          description: "Failed to check for an existing listing",
          variant: "destructive",
        });
        return;
      }

      let listingId: string;

      if (existingRow) {
        const updatedUnits = (existingRow.units || 0) + unitsNum;
        const updatedTotalCost = (existingRow.cost || 0) + totalCostNum;
        const updatedUnitCost = updatedUnits > 0 ? updatedTotalCost / updatedUnits : 0;

        const { error: updateError } = await supabase
          .from("created_listings")
          .update({
            cost: updatedTotalCost,
            amount: updatedUnitCost,
            units: updatedUnits,
            supplier_links: filteredSupplierLinks.length > 0 ? (filteredSupplierLinks as any) : undefined,
            // date_created intentionally untouched — it marks the original
            // listing date; this purchase's date lives in created_listing_purchases.
          })
          .eq("id", existingRow.id);

        if (updateError) {
          console.error("Inventory update error:", updateError);
          toast({
            title: "Error",
            description: "Failed to update existing listing",
            variant: "destructive",
          });
          return;
        }

        const { error: purchaseError } = await supabase
          .from("created_listing_purchases")
          .insert({
            listing_id: existingRow.id,
            user_id: user?.id,
            units: unitsNum,
            unit_cost: cogNum,
            total_cost: totalCostNum,
            purchase_date: dateCreated,
            note: "Create Listing form (repurchase)",
          });
        if (purchaseError) {
          console.error("Purchase history log error:", purchaseError);
        }

        listingId = existingRow.id;
      } else {
        const { data: insertedRow, error: inventoryError } = await supabase
          .from("created_listings")
          .insert([{
            user_id: user?.id!,
            asin: asin.toUpperCase(),
            sku,
            fnsku: fnskuData?.fnsku || null,
            title: productData.title,
            image_url: productData.imageUrl,
            price: parseFloat(sellingPrice),
            cost: totalCostNum, // total cost entered by user
            amount: cogNum,     // calculated COG (unit cost)
            units: unitsNum,
            supplier_links: filteredSupplierLinks as any,
            date_created: dateCreated,
            fba_blocked: blockedNow,
            fba_block_reason: blockedNow ? (eligibility.fba_block_reason ?? null) : null,
            validation_status: initialValidationStatus,
            validation_started_at: willSubmitToAmazon ? new Date().toISOString() : null,
          }])
          .select('id')
          .single();

        if (inventoryError) {
          console.error("Inventory save error:", inventoryError);
          toast({
            title: "Error",
            description: "Failed to save to inventory",
            variant: "destructive",
          });
          return;
        }

        listingId = insertedRow.id;

        const { error: purchaseError } = await supabase
          .from("created_listing_purchases")
          .insert({
            listing_id: insertedRow.id,
            user_id: user?.id,
            units: unitsNum,
            unit_cost: cogNum,
            total_cost: totalCostNum,
            purchase_date: dateCreated,
            note: "Create Listing form",
          });
        if (purchaseError) {
          console.error("Purchase history log error:", purchaseError);
        }
      }

      if (shouldCreateOnAmazon) {
        // Create Amazon listing on selected marketplace
        const { MARKETPLACE_CONFIGS } = await import("@/lib/marketplaceCurrency");
        const mpConfig = MARKETPLACE_CONFIGS[selectedMarketplace];
        const { data: listingData, error: listingError } = await supabase.functions.invoke(
          'create-amazon-listing',
          {
            body: {
              asin: asin.toUpperCase(),
              sku,
              price: parseFloat(sellingPrice),
              quantity: parseInt(quantity),
              condition,
              fulfillmentChannel,
              cost: totalCostNum,
              marketplaceId: mpConfig?.marketplaceId,
              marketplaceCode: selectedMarketplace,
              createdListingId: listingId ?? null,
            },
            headers: { Authorization: `Bearer ${session.access_token}` }
          }
        );

        if (listingError) {
          try {
            const errBody = typeof listingError === 'object' && listingError.message ? JSON.parse(listingError.message) : null;
            if (errBody?.issues) {
              setValidationIssues(errBody.issues);
              setValidationStatus(errBody.status);
              setValidationMode('SUBMIT');
            }
          } catch {}
          throw listingError;
        }

        if (listingData?.issues && listingData.issues.length > 0) {
          setValidationIssues(listingData.issues);
          setValidationStatus(listingData.status);
          setValidationMode('SUBMIT');
        }

        toast({
          title: "Success!",
          description: `Listing created on Amazon and saved to database for ${asin.toUpperCase()}`,
        });
      } else {
        toast({
          title: gatedNow ? "FBM-only listing saved" : "Success!",
          description: gatedNow
            ? `Listing saved to database as FBM only for ${asin.toUpperCase()}. Verify approval on Amazon before creating the Amazon/FBA listing.`
            : `Listing saved to database only for ${asin.toUpperCase()}`,
        });
      }

      // Reset form
      resetForm();
    } catch (error: any) {
      console.error("Create listing error:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to create listing",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setAsin("");
    setProductData(null);
    setSku(generateSKU());
    setTotalCostInput("");
    setUnits("1");
    setSellingPrice("");
    setQuantity("1");
    setCondition("new_new");
    setFulfillmentChannel("FBA");
    setSupplierLinks([{ link: "", discount_code: "" }]);
    setValidationIssues(null);
    setValidationStatus(undefined);
    setValidationMode(undefined);
    setCreateConfirmed(false);
    setDetectedBrand(null);
    setIsGenericBrand(false);
  };

  const validateListing = async () => {
    if (!productData || !sku || !sellingPrice) {
      toast({ title: "Missing Information", description: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    try {
      setIsValidating(true);
      setValidationIssues(null);
      setCreateConfirmed(false);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const eligibility = await runRequiredFbaGate();
      const selectedGate = productData?.marketplaceGating?.find(mp => mp.marketplace === selectedMarketplace);
      const marketplaceStatus = selectedGate?.status || productData?.gatingStatus;
      const marketplaceGated = marketplaceStatus === "APPROVAL_REQUIRED" || marketplaceStatus === "RESTRICTED";
      if (!eligibility || eligibility.eligible === false || marketplaceGated) return;

      const { MARKETPLACE_CONFIGS } = await import("@/lib/marketplaceCurrency");
      const mpConfig = MARKETPLACE_CONFIGS[selectedMarketplace];
      const { data, error } = await supabase.functions.invoke('create-amazon-listing', {
        body: {
          asin: asin.toUpperCase(),
          sku,
          price: parseFloat(sellingPrice),
          quantity: parseInt(quantity),
          condition,
          fulfillmentChannel,
          mode: 'VALIDATION_PREVIEW',
          marketplaceId: mpConfig?.marketplaceId,
          marketplaceCode: selectedMarketplace,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      // Handle edge function errors (non-2xx)
      if (error) {
        // Try to parse error body for issues
        try {
          const errBody = JSON.parse(error.message || '{}');
          if (errBody.issues) {
            setValidationIssues(errBody.issues);
            setValidationStatus(errBody.status);
            setValidationMode('VALIDATION_PREVIEW');
            return;
          }
        } catch {}
        toast({ title: "Validation Error", description: error.message, variant: "destructive" });
        return;
      }

      setValidationIssues(data?.issues || []);
      setValidationStatus(data?.status);
      setValidationMode('VALIDATION_PREVIEW');
      setDetectedBrand(data?.brand || null);
      setIsGenericBrand(data?.isGenericBrand || false);

      if (data?.issues?.length === 0 || data?.status === 'ACCEPTED') {
        toast({ title: "✓ Validation Passed", description: "No issues found — safe to create the listing." });
      } else {
        toast({ title: "Issues Found", description: `Amazon returned ${data?.issues?.length || 0} issue(s). Review them below.`, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Validation Error", description: error.message, variant: "destructive" });
    } finally {
      setIsValidating(false);
    }
  };

  const calculateROI = () => {
    // ROI = (Profit / Cost) * 100
    // Profit = Selling Price - Amazon Fees - Cost
    // This matches SellerAmp's ROI calculation
    if (!totalCostInput || !sellingPrice || !units) return null;
    const cogNum = calculateCOG();
    const priceNum = parseFloat(sellingPrice);
    if (isNaN(cogNum) || isNaN(priceNum) || cogNum === 0) return null;

    // Get fees from product data (fetched from Amazon)
    let totalFees = 0;
    if (productData?.fees) {
      const fees = productData.fees;
      totalFees = (fees.referralFee || 0) + (fees.fbaFee || 0) + (fees.variableClosingFee || 0);
    }

    const profit = priceNum - totalFees - cogNum;
    const roi = (profit / cogNum) * 100;
    return roi.toFixed(2);
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      <Helmet>
        <title>Create Amazon Listing | InventorySprint</title>
        <meta name="description" content="Create Amazon FBA listings with inventory tracking" />
      </Helmet>
      
      {/* Animated gradient orbs */}
      <div className="fixed top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse pointer-events-none" />
      <div className="fixed bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse pointer-events-none" style={{ animationDelay: '1s' }} />
      {/* Grid pattern overlay */}
      <div className="fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] pointer-events-none" />
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12 relative z-10">
        <div className="container mx-auto px-4 max-w-4xl">
          <button
            onClick={() => navigate("/tools/created-listings")}
            className="mb-4 inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            Back to Product Library
          </button>
          <div className="mb-6 flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-extrabold flex items-center gap-2 text-white">
                <Package className="w-8 h-8 text-primary" />
                Create Amazon Listing
              </h1>
              <p className="text-gray-400 mt-1">
                Create listings and track inventory with supplier information
              </p>
            </div>
            {isAdmin && (
              <Button variant="outline" onClick={() => window.location.href = "/tools/inventory"} className="border-white/20 text-white hover:bg-white/10">
                View Inventory
              </Button>
            )}
          </div>

          {/* Step 1: Fetch Product */}
          <Card className="mb-6 bg-white/60 backdrop-blur-sm border-white/20">
            <CardHeader>
              <CardTitle className="text-[hsl(221,90%,22%)] font-extrabold">Step 1: Find Product</CardTitle>
              <CardDescription className="text-[hsl(221,90%,22%)]/70">
                Enter an ASIN to fetch product details and price from Amazon
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="asin" className="text-[hsl(221,90%,22%)] font-semibold">ASIN</Label>
                <div className="flex gap-2">
                  <Input 
                    id="asin"
                    placeholder="Enter ASIN (e.g., B07XYZ1234)" 
                    value={asin} 
                    onChange={(e) => setAsin(e.target.value.toUpperCase())}
                    className="flex-1 uppercase"
                    maxLength={10}
                  />
                  <Button 
                    onClick={fetchProductData} 
                    disabled={isFetching || !asin}
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Fetching...
                      </>
                    ) : (
                      "Fetch Product"
                    )}
                  </Button>
                </div>
              </div>

              {productData && (
                <div className="p-4 bg-muted rounded-lg flex gap-4">
                  {productData.imageUrl && (
                    <img 
                      src={productData.imageUrl} 
                      alt={productData.title}
                      className="w-24 h-24 object-contain rounded"
                    />
                  )}
                  <div className="flex-1">
                    <h3 className="font-semibold mb-1">Product Title</h3>
                    <p className="text-sm">{productData.title}</p>
                    {productData.price && (
                      <p className="text-sm text-primary font-semibold mt-2">
                        Amazon Price: ${productData.price.toFixed(2)}
                      </p>
                    )}
                    {/* Multi-Marketplace Gating Status — only connected marketplaces returned from backend */}
                    {productData.marketplaceGating && productData.marketplaceGating.length > 0 ? (
                      (() => {
                        const filteredGating = productData.marketplaceGating.filter(mp =>
                          mp.status !== 'NO_SELLER_AUTH' && mp.status !== 'NOT_CONNECTED'
                        );
                        if (filteredGating.length === 0) return null;
                        return (
                          <div className="mt-3">
                            <h4 className="text-xs font-semibold text-muted-foreground mb-2">
                              Marketplace Eligibility
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {filteredGating.map((mp) => (
                                <div 
                                  key={mp.marketplace}
                                  className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs border ${
                                    mp.status === 'APPROVED' 
                                      ? 'bg-green-50 border-green-200 text-green-800' 
                                      : mp.status === 'APPROVAL_REQUIRED'
                                      ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                                      : mp.status === 'RESTRICTED'
                                      ? 'bg-red-50 border-red-200 text-red-800'
                                      : 'bg-gray-50 border-gray-200 text-gray-600'
                                  }`}
                                  title={mp.reasons.length > 0 ? mp.reasons.join(', ') : mp.status}
                                >
                                  <span className="text-base">{mp.flag}</span>
                                  <span className="font-medium">{mp.marketplace}</span>
                                  {mp.status === 'APPROVED' && (
                                    <span className="ml-auto text-green-600">✓</span>
                                  )}
                                  {mp.status === 'APPROVAL_REQUIRED' && (
                                    <span className="ml-auto text-yellow-600">⚠</span>
                                  )}
                                  {mp.status === 'RESTRICTED' && (
                                    <span className="ml-auto text-red-600">✗</span>
                                  )}
                                  {mp.status === 'ERROR' && (
                                    <span className="ml-auto text-gray-400">?</span>
                                  )}
                                </div>
                              ))}
                            </div>
                            {/* Request Approval Links for non-approved marketplaces */}
                            {filteredGating.some(mp => 
                              mp.status === 'APPROVAL_REQUIRED' || mp.status === 'RESTRICTED'
                            ) && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {filteredGating
                                  .filter(mp => mp.status === 'APPROVAL_REQUIRED' || mp.status === 'RESTRICTED')
                                  .map(mp => {
                                    return (
                                      <a 
                                        key={mp.marketplace}
                                        href={approvalUrlFor(asin, mp.marketplace)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                      >
                                        {mp.flag} Request {mp.marketplace} Approval →
                                      </a>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                        );
                      })()
                    ) : (
                      // Fallback to legacy single gating display
                      <div className="mt-3">
                        {productData.gatingStatus === 'APPROVED' && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            ✓ Approved to Sell
                          </span>
                        )}
                        {productData.gatingStatus === 'APPROVAL_REQUIRED' && (
                          <div>
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              ⚠ Approval Required
                            </span>
                            {productData.gatingReasons && productData.gatingReasons.length > 0 && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {productData.gatingReasons.join(', ')}
                              </p>
                            )}
                            <a 
                              href={approvalUrlFor(asin, selectedMarketplace)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
                            >
                              Request Approval →
                            </a>
                          </div>
                        )}
                        {productData.gatingStatus === 'RESTRICTED' && (
                          <div>
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              ✗ Restricted
                            </span>
                            {productData.gatingReasons && productData.gatingReasons.length > 0 && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {productData.gatingReasons.join(', ')}
                              </p>
                            )}
                            <a 
                              href={approvalUrlFor(asin, selectedMarketplace)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
                            >
                              Request Approval →
                            </a>
                          </div>
                        )}
                        {productData.gatingStatus === 'NO_SELLER_AUTH' && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                            Connect Amazon account to check gating
                          </span>
                        )}
                        {productData.gatingStatus === 'ERROR' && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                            Could not check gating status
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Step 2: Configure Listing */}
          {productData && (
            <Card className="mb-6 bg-white/60 backdrop-blur-sm border-white/20">
              <CardHeader>
                <CardTitle className="text-[hsl(221,90%,22%)] font-extrabold">Step 2: Configure Your Listing</CardTitle>
                <CardDescription className="text-[hsl(221,90%,22%)]/70">
                  Set up SKU, pricing, cost calculation, and supplier information
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Marketplace Selector */}
                <div className="space-y-2">
                  <Label>Target Marketplace *</Label>
                  {isAdmin ? (
                    <div className="space-y-2">
                      <div className="h-10 px-3 py-2 bg-muted rounded-md flex items-center gap-2 text-sm">
                        <span>{MARKETPLACE_FLAGS[primaryMarketplace] || '🌐'}</span>
                        <span className="font-medium">{primaryMarketplace}</span>
                        <span className="text-muted-foreground text-xs">(Primary — admin restricted)</span>
                      </div>
                      <details className="text-xs">
                        <summary className="cursor-pointer text-primary hover:underline">Change primary marketplace</summary>
                        <div className="mt-2">
                          <Select 
                            value={primaryMarketplace} 
                            onValueChange={async (val) => {
                              setPrimaryMarketplace(val);
                              setSelectedMarketplace(val);
                              await supabase
                                .from("profiles")
                                .update({ primary_marketplace_id: val } as any)
                                .eq("id", user?.id);
                              toast({ title: "Primary marketplace updated", description: `Set to ${val}` });
                            }}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-background border z-50">
                              {userMarketplaces.map(mp => (
                                <SelectItem key={mp} value={mp}>
                                  {MARKETPLACE_FLAGS[mp] || '🌐'} {mp}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </details>
                    </div>
                  ) : (
                    <Select value={selectedMarketplace} onValueChange={setSelectedMarketplace}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-background border z-50">
                        {userMarketplaces.map(mp => (
                          <SelectItem key={mp} value={mp}>
                            {MARKETPLACE_FLAGS[mp] || '🌐'} {mp}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {isAdmin 
                      ? 'Admins can only create listings on their primary marketplace. Expand to change it.'
                      : 'Select which connected marketplace to create the listing on'
                    }
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="sku">SKU (Auto-generated) *</Label>
                    <Input 
                      id="sku"
                      value={sku} 
                      onChange={(e) => setSku(e.target.value)}
                      className="font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your unique product identifier
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fulfillment">Fulfillment Method *</Label>
                    <Select value={fulfillmentChannel} onValueChange={setFulfillmentChannel}>
                      <SelectTrigger id="fulfillment">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-background border z-50">
                        <SelectItem value="FBA" disabled={fbaHardGate}>
                          FBA (Fulfillment by Amazon){fbaHardGate ? " — verify approval first" : ""}
                        </SelectItem>
                        <SelectItem value="FBM">FBM (Fulfilled by Merchant)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* FBA Eligibility gate — shared with extension, Add Purchase, Print, Shipment Builder */}
                <FbaReadinessTracker
                  eligibility={fbaElig.data}
                  loading={fbaElig.loading}
                  onRecheck={fbaElig.recheck}
                  onRunDryRun={fbaElig.runDryRun}
                  dryRunLoading={fbaElig.dryRunLoading}
                  sellabilityApproved={selectedMarketplaceApproved}
                />

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="totalCost" className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4" />
                      Total Cost *
                    </Label>
                    <Input 
                      id="totalCost"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="100.00" 
                      value={totalCostInput} 
                      onChange={(e) => setTotalCostInput(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Total amount purchased
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="units">Units</Label>
                    <Input 
                      id="units"
                      type="number"
                      min="1"
                      placeholder="1" 
                      value={units} 
                      onChange={(e) => setUnits(e.target.value || "1")}
                    />
                    <p className="text-xs text-muted-foreground">
                      Number of units
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>COG (Unit Cost)</Label>
                    <div className="h-10 px-3 py-2 bg-muted rounded-md flex items-center font-semibold text-muted-foreground">
                      ${calculateCOG().toFixed(2)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Total Cost ÷ Units
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="price">Selling Price (from Amazon) *</Label>
                    <Input 
                      id="price"
                      type="number"
                      step="0.01"
                      placeholder="19.99" 
                      value={sellingPrice} 
                      onChange={(e) => setSellingPrice(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="condition">Condition *</Label>
                    <Select value={condition} onValueChange={setCondition}>
                      <SelectTrigger id="condition">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-background border z-50">
                        <SelectItem value="new_new">New</SelectItem>
                        <SelectItem value="used_like_new">Used - Like New</SelectItem>
                        <SelectItem value="used_very_good">Used - Very Good</SelectItem>
                        <SelectItem value="used_good">Used - Good</SelectItem>
                        <SelectItem value="used_acceptable">Used - Acceptable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {fulfillmentChannel === "FBM" && (
                  <div className="space-y-2">
                    <Label htmlFor="quantity">Quantity *</Label>
                    <Input 
                      id="quantity"
                      type="number"
                      min="1"
                      placeholder="1" 
                      value={quantity} 
                      onChange={(e) => setQuantity(e.target.value)}
                      className="max-w-xs"
                    />
                  </div>
                )}

                {/* Supplier Links */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label>Supplier Links</Label>
                    <Button type="button" size="sm" variant="outline" onClick={addSupplierLink}>
                      <Plus className="w-4 h-4 mr-1" />
                      Add Supplier
                    </Button>
                  </div>
                  {supplierLinks.map((supplier, index) => (
                    <div key={index} className="flex gap-2 items-start">
                      <div className="flex-1 space-y-2">
                        <Input
                          placeholder="Supplier website URL"
                          value={supplier.link}
                          onChange={(e) => updateSupplierLink(index, "link", e.target.value)}
                        />
                        <Input
                          placeholder="Discount code (optional)"
                          value={supplier.discount_code}
                          onChange={(e) => updateSupplierLink(index, "discount_code", e.target.value)}
                        />
                      </div>
                      {supplierLinks.length > 1 && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeSupplierLink(index)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                {calculateROI() !== null && (
                  <div className="p-3 bg-muted rounded-lg">
                    <span className={`text-lg font-semibold ${parseFloat(calculateROI()!) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ROI: {calculateROI()}%
                    </span>
                  </div>
                )}

                 {/* Show warning if gated */}
                  {selectedMarketplaceGated && (
                   <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
                     You cannot create this listing because you are not approved to sell this product. 
                     <a 
                       href={approvalUrlFor(asin, selectedMarketplace)}
                       target="_blank"
                       rel="noopener noreferrer"
                       className="ml-1 text-primary hover:underline font-medium"
                     >
                       Request approval first →
                     </a>
                   </div>
                 )}

                 {/* Risk Checks Panel — separate from schema validation */}
                 {validationIssues !== null && (
                   <RiskChecksPanel
                     brand={detectedBrand}
                     isGenericBrand={isGenericBrand}
                     gatingStatus={productData?.gatingStatus}
                     validationPassed={validationIssues.length === 0 || validationStatus === 'ACCEPTED'}
                   />
                 )}

                 {/* Validation Issues Panel */}
                 {validationIssues !== null && (
                   <ListingIssuesPanel issues={validationIssues} status={validationStatus} mode={validationMode} />
                 )}

                 {/* Create anyway confirmation for errors */}
                 {validationIssues && validationIssues.some(i => i.severity === 'ERROR') && !createConfirmed && (
                   <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between">
                     <span>Amazon reported errors. Creating may fail.</span>
                     <Button size="sm" variant="destructive" onClick={() => setCreateConfirmed(true)}>
                       Create anyway
                     </Button>
                   </div>
                 )}

                 {/* Warning banner for non-error issues */}
                 {validationIssues && validationIssues.length > 0 && !validationIssues.some(i => i.severity === 'ERROR') && (
                   <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
                     ⚠ Amazon returned warnings. You can still create the listing.
                   </div>
                 )}

                 <div className="flex items-center gap-3 pt-4 pb-2">
                   <Label className="text-sm font-medium">Create to:</Label>
                   <div className="flex rounded-lg border border-border overflow-hidden">
                     <button
                       type="button"
                        onClick={() => !fbaHardGate && setCreateMode("amazon")}
                        disabled={fbaHardGate}
                        title={fbaHardGate ? "Verify Amazon approval before creating on Amazon" : ""}
                       className={`px-4 py-2 text-sm font-medium transition-colors ${
                         createMode === "amazon"
                           ? "bg-primary text-primary-foreground"
                           : "bg-muted text-muted-foreground hover:bg-muted/80"
                        } ${fbaHardGate ? "opacity-50 cursor-not-allowed" : ""}`}
                     >
                        Amazon + Database{fbaHardGate ? " — verify first" : ""}
                     </button>
                     <button
                       type="button"
                       onClick={() => setCreateMode("database")}
                       className={`px-4 py-2 text-sm font-medium transition-colors ${
                         createMode === "database"
                           ? "bg-primary text-primary-foreground"
                           : "bg-muted text-muted-foreground hover:bg-muted/80"
                       }`}
                     >
                       Database Only
                     </button>
                   </div>
                 </div>

                 <div className="flex gap-2">
                  {createMode === "amazon" && (
                   <Button
                     onClick={validateListing}
                     disabled={isValidating || isCreating || !sku || !sellingPrice}
                     variant="outline"
                     className="flex-1"
                   >
                     {isValidating ? (
                       <>
                         <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                         Validating...
                       </>
                     ) : (
                       <>
                         <ShieldCheck className="w-4 h-4 mr-2" />
                         Validate First
                       </>
                     )}
                   </Button>
                  )}
                   <Button 
                     onClick={createListing}
                      disabled={
                        isCreating || !sku || !totalCostInput ||
                        (createMode === "amazon" && !sellingPrice) ||
                        isGenericBrand ||
                         (createMode === "amazon" && fbaHardGate) ||
                         (fulfillmentChannel === "FBA" && fbaHardGate) ||
                        (createMode === "amazon" && validationIssues?.some(i => i.severity === 'ERROR') && !createConfirmed)
                      }
                     className="flex-1"
                   >
                     {isCreating ? (
                       <>
                         <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                         Creating...
                       </>
                     ) : createMode === "amazon" ? (
                       "Create Amazon Listing"
                     ) : (
                       "Save to Database"
                     )}
                   </Button>
                   <Button 
                     onClick={resetForm}
                     variant="outline"
                   >
                     Reset
                   </Button>
                 </div>
              </CardContent>
            </Card>
          )}

          {!productData && (
            <Card className="border-dashed bg-white/60 backdrop-blur-sm border-white/20">
              <CardContent className="py-12 text-center text-[hsl(221,90%,22%)]/60">
                <Package className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Enter an ASIN above to get started</p>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default CreateListing;
