import { useState, useCallback, useRef } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Search, Loader2, ExternalLink, ShoppingCart, ChevronLeft, ChevronRight, RotateCcw, Globe, Upload, Database, Trash2, Download, ShieldCheck, ShieldX, ShieldAlert } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { fetchGoogleShoppingResults } from "@/lib/googleShopping";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface SimpleProduct {
  asin: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  image_url: string | null;
  imported_at: string;
  new_offer_count: number | null;
  fba_offer_count: number | null;
  fbm_offer_count: number | null;
}

type EligibilityStatus = 'pending' | 'checking' | 'approved' | 'restricted' | 'approval_required' | 'error';

// ASINs per check-product-eligibility invocation. The function checks them
// SEQUENTIALLY with a 500ms pause every 5, so 20 is ~12s of wall time - well
// inside the edge-function timeout, and ~2 SP-API calls/sec, under the
// getListingsRestrictions limit. Raising this cuts round-trips; adding PARALLEL
// invocations would not help, because the per-operation quota is shared.
const BATCH_SIZE = 20;

// Hard ceiling on how deep "Find Products" will page. Was 500, which capped a
// 1,000-row Excel import at two pages. Imports here run to 5,000-10,000+, so
// this is a runaway guard, not a product limit - do not lower it to "tidy up".
const MAX_SEARCH_RESULTS = 1000000;

// Days a stored verdict stays usable. Matches check-product-eligibility's own
// freshness_days default, and is what makes an interrupted sweep resumable:
// anything already decided inside this window is not sent again.
const VERDICT_FRESH_DAYS = 7;

const KeepaProductFinder = () => {
  const { user } = useAuth();
  const [searchText, setSearchText] = useState("");
  const [brandFilter, setBrandFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fbaCompMin, setFbaCompMin] = useState<string>("");
  const [fbaCompMax, setFbaCompMax] = useState<string>("");
  const [totalCompMin, setTotalCompMin] = useState<string>("");
  const [totalCompMax, setTotalCompMax] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState<SimpleProduct[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [page, setPage] = useState(0);
  const [perPage] = useState(250);
  const [uploading, setUploading] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [exportingApproved, setExportingApproved] = useState(false);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedAsins, setSelectedAsins] = useState<Set<string>>(new Set());
  const [googleSearching, setGoogleSearching] = useState(false);
  const [googleSearchingAsin, setGoogleSearchingAsin] = useState<string | null>(null);
  const [dbStats, setDbStats] = useState<{ total: number; lastImport: string | null } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Eligibility state — per-ASIN status map
  const [eligibilityMap, setEligibilityMap] = useState<Record<string, EligibilityStatus>>({});
  const [eligibilityProgress, setEligibilityProgress] = useState<{ checked: number; total: number } | null>(null);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const scanAbortRef = useRef<AbortController | null>(null);

  // Load distinct brands and categories for dropdowns
  const loadFilterOptions = useCallback(async () => {
    const allCategories: string[] = [];
    const allBrands: string[] = [];
    
    let catOffset = 0;
    const catPageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from('keepa_simple_products' as any)
        .select('category')
        .not('category', 'is', null)
        .order('category')
        // category is not unique, so it cannot order pages on its own:
        // a tie spanning a page boundary repeats or skips rows. asin breaks it.
        .order("asin", { ascending: true })
        .range(catOffset, catOffset + catPageSize - 1);
      if (!data || data.length === 0) break;
      for (const row of data as any[]) {
        if (row.category && !allCategories.includes(row.category)) {
          allCategories.push(row.category);
        }
      }
      if (data.length < catPageSize) break;
      catOffset += catPageSize;
      if (catOffset > 100000) break;
    }
    setCategories(allCategories.sort());

    const brandSet = new Set<string>();
    let brandOffset = 0;
    const brandPageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from('keepa_simple_products' as any)
        .select('brand')
        .not('brand', 'is', null)
        .order('brand')
        // brand is not unique, so it cannot order pages on its own:
        // a tie spanning a page boundary repeats or skips rows. asin breaks it.
        .order("asin", { ascending: true })
        .range(brandOffset, brandOffset + brandPageSize - 1);
      if (!data || data.length === 0) break;
      for (const row of data as any[]) {
        if (row.brand) brandSet.add(row.brand);
      }
      if (data.length < brandPageSize) break;
      brandOffset += brandPageSize;
      if (brandOffset > 100000) break;
    }
    setBrands([...brandSet].sort());

    const statsRes = await supabase.from('keepa_simple_products' as any).select('asin', { count: 'exact', head: true });
    const { data: latestRow } = await (supabase.from('keepa_simple_products' as any) as any)
      .select('imported_at')
      .order('imported_at', { ascending: false })
      .limit(1);

    setDbStats({
      total: statsRes.count ?? 0,
      lastImport: latestRow?.[0]?.imported_at ?? null,
    });
  }, []);

  // Load filter options on mount
  useState(() => { loadFilterOptions(); });

  // Progressive eligibility check — called after products are loaded
  const checkEligibilityProgressive = useCallback(async (
    asins: string[],
    opts: { forceRescan?: boolean; skipKnown?: boolean } = {},
  ) => {
    if (!user || asins.length === 0) return;
    const forceRescan = opts.forceRescan === true;
    const skipKnown = opts.skipKnown !== false && !forceRescan;

    // Cancel any previous scan
    if (scanAbortRef.current) scanAbortRef.current.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    // Merge, do not replace: a sweep covers ASINs that are not on the displayed
    // page, and that page's badges may already be hydrated from storage.
    // Replacing the map would blank them.
    setEligibilityMap(prev => {
      const next = { ...prev };
      for (const a of asins) if (!next[a]) next[a] = 'pending';
      return next;
    });

    // Resume rather than restart. A 10,000-ASIN sweep is ~90 minutes of SP-API
    // calls, so it WILL get interrupted - a closed tab, a changed filter, a
    // reload. The function persists each verdict as it goes (chunks of 100), so
    // re-running only needs to cover what is still undecided.
    //
    // This trusts recent non-approved verdicts, which the edge function itself
    // does not. That is safe here precisely BECAUSE of the freshness window: the
    // reason the function re-scans non-approved rows is that pre-fix code could
    // cache a Used/Refurbished restriction against a New listing, and such rows
    // are far older than VERDICT_FRESH_DAYS. Anything decided this week was
    // decided by current code.
    let targets = asins;
    let alreadyKnown = 0;
    if (skipKnown) {
      const since = new Date();
      since.setDate(since.getDate() - VERDICT_FRESH_DAYS);
      const decided: Record<string, EligibilityStatus> = {};
      for (let i = 0; i < asins.length; i += 200) {
        if (controller.signal.aborted) return;
        const chunk = asins.slice(i, i + 200);
        const { data } = await (supabase.from('user_approved_products' as any) as any)
          .select('asin, approval_status, checked_at')
          .eq('user_id', user.id)
          .eq('marketplace', 'US')
          .gte('checked_at', since.toISOString())
          .in('asin', chunk);
        for (const r of (data as any[]) || []) {
          const st = String(r.approval_status || '').toLowerCase();
          if (st === 'error' || !st) continue; // an error is not a verdict - retry it
          decided[r.asin] = st === 'approved' ? 'approved'
            : st === 'approval_required' ? 'approval_required'
            : 'restricted';
        }
      }
      alreadyKnown = Object.keys(decided).length;
      if (alreadyKnown > 0) {
        setEligibilityMap(prev => ({ ...prev, ...decided }));
        targets = asins.filter(a => !decided[a]);
      }
    }

    if (targets.length === 0) {
      setEligibilityProgress(null);
      toast({
        title: "Already checked",
        description: `All ${asins.length.toLocaleString()} products already have a verdict from the last ${VERDICT_FRESH_DAYS} days.`,
      });
      return;
    }

    setEligibilityProgress({ checked: alreadyKnown, total: asins.length });

    let checked = alreadyKnown;

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (controller.signal.aborted) return;

      const batch = targets.slice(i, i + BATCH_SIZE);

      // Mark this batch as 'checking'
      setEligibilityMap(prev => {
        const next = { ...prev };
        batch.forEach(a => { next[a] = 'checking'; });
        return next;
      });

      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: batch, force_rescan: forceRescan },
        });

        if (controller.signal.aborted) return;

        if (error) {
          setEligibilityMap(prev => {
            const next = { ...prev };
            batch.forEach(a => { next[a] = 'error'; });
            return next;
          });
        } else {
          const results: { asin: string; status: string }[] = data?.results || [];
          setEligibilityMap(prev => {
            const next = { ...prev };
            // Map results
            for (const r of results) {
              next[r.asin] = r.status === 'approved' ? 'approved'
                : r.status === 'approval_required' ? 'approval_required'
                : 'restricted';
            }
            // Mark any batch ASINs not in results as error
            for (const a of batch) {
              if (!next[a] || next[a] === 'checking') next[a] = 'error';
            }
            return next;
          });
        }
      } catch {
        if (controller.signal.aborted) return;
        setEligibilityMap(prev => {
          const next = { ...prev };
          batch.forEach(a => { next[a] = 'error'; });
          return next;
        });
      }

      checked += batch.length;
      setEligibilityProgress({ checked: Math.min(checked, asins.length), total: asins.length });
      // (total stays the FULL set so the bar reflects real coverage, not just this run)
    }

    setEligibilityProgress(null);
  }, [user, toast]);

  // Fetch the user's owned ASINs (already delivered to them) so we can exclude them
  const fetchOwnedAsins = async (): Promise<Set<string>> => {
    if (!user) return new Set();
    const owned = new Set<string>();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await (supabase.from('user_owned_products' as any) as any)
        .select('asin')
        .eq('user_id', user.id)
        .eq('marketplace', 'US')
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error || !data || data.length === 0) break;
      for (const row of data as any[]) owned.add(row.asin);
      if (data.length < pageSize) break;
      offset += pageSize;
      if (offset > 200000) break;
    }
    return owned;
  };

  // One definition of the filter clauses, applied by BOTH the paged search and
  // the full-table Check All sweep. Duplicating them is how the two would drift.
  const applyFilters = (query: any) => {
    if (searchText.trim()) {
      const term = searchText.trim();
      if (/^[A-Z0-9]{10}$/i.test(term)) {
        query = query.ilike('asin', term);
      } else {
        query = query.or(`title.ilike.%${term}%,brand.ilike.%${term}%`);
      }
    }
    if (brandFilter !== "all") query = query.eq('brand', brandFilter);
    if (categoryFilter !== "all") query = query.eq('category', categoryFilter);

    const fbaMin = fbaCompMin.trim() === "" ? null : parseInt(fbaCompMin, 10);
    const fbaMax = fbaCompMax.trim() === "" ? null : parseInt(fbaCompMax, 10);
    const totMin = totalCompMin.trim() === "" ? null : parseInt(totalCompMin, 10);
    const totMax = totalCompMax.trim() === "" ? null : parseInt(totalCompMax, 10);
    if (fbaMin !== null && Number.isFinite(fbaMin)) query = query.gte('fba_offer_count', fbaMin);
    if (fbaMax !== null && Number.isFinite(fbaMax)) query = query.lte('fba_offer_count', fbaMax);
    if (totMin !== null && Number.isFinite(totMin)) query = query.gte('new_offer_count', totMin);
    if (totMax !== null && Number.isFinite(totMax)) query = query.lte('new_offer_count', totMax);
    return query;
  };

  // Sweep eligibility over EVERY product matching the current filters, not just
  // the 250 on the loaded page.
  //
  // Deliberately ignores the user_owned_products exclusion that handleSearch
  // applies. That exclusion is a delivery mechanic ("do not show me what I have
  // already been given") and every search writes the rows it returned into it -
  // so after a few searches most of an Excel import is marked owned, and
  // anything built on the search path would silently skip it.
  // Every ASIN matching the current filters, paged past PostgREST's row cap.
  // The scan reads from here rather than from the loaded page: the page is 250
  // rows, which is what made the progress bar stop at 250.
  const collectAllMatchingAsins = async (): Promise<string[]> => {
    const asins: string[] = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await applyFilters(
        supabase.from('keepa_simple_products' as any).select('asin'),
      )
        // asin is the primary key, so it orders pages without ties - a
        // non-unique sort key repeats or skips rows at a page boundary.
        .order('asin', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const rows = (data as any[]) || [];
      if (rows.length === 0) break;
      for (const r of rows) if (r.asin) asins.push(r.asin);
      if (rows.length < pageSize) break;
      offset += pageSize;
      if (offset > MAX_SEARCH_RESULTS) break;
    }
    return asins;
  };

  const handleCheckAll = async () => {
    if (!user) return;
    setCheckingAll(true);
    try {
      const asins = await collectAllMatchingAsins();

      if (asins.length === 0) {
        toast({ title: "Nothing to check", description: "No products match the current filters." });
        return;
      }

      // Roughly 0.6s of SP-API time per ASIN, measured against the function's
      // own sequential loop and its 500ms pause every 5 calls.
      const mins = Math.max(1, Math.round((asins.length * 0.6) / 60));
      toast({
        title: `Checking ${asins.length.toLocaleString()} products`,
        description: `About ${mins} min if none are cached. Keep this tab open - if it closes, press Check All again and it resumes where it stopped.`,
      });

      await checkEligibilityProgressive(asins, { skipKnown: true });
    } catch (e: any) {
      toast({ title: "Check failed", description: e.message, variant: "destructive" });
    } finally {
      setCheckingAll(false);
    }
  };

  // Export every APPROVED product matching the current filters to .xlsx.
  //
  // Reads the verdicts from the database rather than from eligibilityMap, which
  // only holds what this session has seen. After a 10,000-ASIN sweep the
  // approved set is far larger than the 250 rows on screen, and an export built
  // from the page would quietly hand back a fraction of it.
  const handleExportApproved = async () => {
    if (!user) return;
    setExportingApproved(true);
    try {
      const matching = await collectAllMatchingAsins();
      if (matching.length === 0) {
        toast({ title: "Nothing to export", description: "No products match the current filters." });
        return;
      }

      // Which of them are approved, per the stored verdicts.
      const approved = new Map<string, string>(); // asin -> checked_at
      for (let i = 0; i < matching.length; i += 200) {
        const chunk = matching.slice(i, i + 200);
        const { data, error } = await (supabase.from('user_approved_products' as any) as any)
          .select('asin, approval_status, checked_at')
          .eq('user_id', user.id)
          .eq('marketplace', 'US')
          .eq('approval_status', 'approved')
          .in('asin', chunk);
        if (error) throw error;
        for (const r of (data as any[]) || []) approved.set(r.asin, r.checked_at);
      }

      if (approved.size === 0) {
        toast({
          title: "No approved products",
          description: "Nothing in the current filters has an approved verdict yet. Run Check All first.",
        });
        return;
      }

      // Product detail for those ASINs.
      const approvedAsins = [...approved.keys()];
      const details = new Map<string, any>();
      for (let i = 0; i < approvedAsins.length; i += 200) {
        const chunk = approvedAsins.slice(i, i + 200);
        const { data, error } = await (supabase.from('keepa_simple_products' as any) as any)
          .select('asin, title, brand, category, image_url, new_offer_count, fba_offer_count, fbm_offer_count')
          .in('asin', chunk);
        if (error) throw error;
        for (const r of (data as any[]) || []) details.set(r.asin, r);
      }

      const rows = approvedAsins
        .map(asin => {
          const d = details.get(asin) || {};
          return {
            ASIN: asin,
            Title: d.title ?? '',
            Brand: d.brand ?? '',
            Category: d.category ?? '',
            'Total Offers': d.new_offer_count ?? '',
            'FBA Offers': d.fba_offer_count ?? '',
            'FBM Offers': d.fbm_offer_count ?? '',
            'Image URL': d.image_url ?? '',
            'Amazon URL': `https://www.amazon.com/dp/${asin}`,
            Eligibility: 'Approved',
            'Checked At': approved.get(asin) ?? '',
          };
        })
        .sort((a, b) => String(a.Title).localeCompare(String(b.Title)));

      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [
        { wch: 12 }, { wch: 60 }, { wch: 22 }, { wch: 24 },
        { wch: 12 }, { wch: 11 }, { wch: 11 },
        { wch: 40 }, { wch: 36 }, { wch: 12 }, { wch: 22 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Approved");
      XLSX.writeFile(wb, `approved_products_${new Date().toISOString().slice(0, 10)}.xlsx`);

      toast({
        title: "Export ready",
        description: `${rows.length.toLocaleString()} approved products of ${matching.length.toLocaleString()} matching.`,
      });
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    } finally {
      setExportingApproved(false);
    }
  };

  // Badges used to live only in eligibilityMap, which handleSearch cleared on
  // every search - so a page that had already been scanned came back blank and
  // invited a re-scan for data already in the table. Hydrate from the stored
  // verdicts instead, and let a live scan overwrite them.
  const loadStoredEligibility = useCallback(async (asins: string[]) => {
    if (!user || asins.length === 0) return;
    const found: Record<string, EligibilityStatus> = {};
    for (let i = 0; i < asins.length; i += 200) {
      const chunk = asins.slice(i, i + 200);
      const { data } = await (supabase.from('user_approved_products' as any) as any)
        .select('asin, approval_status')
        .eq('user_id', user.id)
        .eq('marketplace', 'US')
        .in('asin', chunk);
      for (const r of (data as any[]) || []) {
        const st = String(r.approval_status || '').toLowerCase();
        found[r.asin] = st === 'approved' ? 'approved'
          : st === 'approval_required' ? 'approval_required'
          : st === 'error' ? 'error'
          : 'restricted';
      }
    }
    setEligibilityMap(prev => {
      const next = { ...prev };
      for (const [a, st] of Object.entries(found)) {
        if (!next[a] || next[a] === 'pending') next[a] = st;
      }
      return next;
    });
  }, [user]);

  const handleSearch = async (searchPage = 0) => {
    setLoading(true);
    setSelectedAsins(new Set());
    // Cancel any ongoing scan
    if (scanAbortRef.current) scanAbortRef.current.abort();
    setEligibilityProgress(null);

    try {
      // 1. Load owned ASINs (permanent exclusion)
      const ownedAsins = await fetchOwnedAsins();

      // 2. Build query, fetch a wider pool then filter out owned client-side
      //    (Postgres NOT IN with thousands of values is fragile; client-side filter is safer)
      const maxResults = MAX_SEARCH_RESULTS;
      const from = searchPage * perPage;
      if (from >= maxResults) {
        setProducts([]);
        toast({ title: "Limit reached", description: `Paging stops at ${MAX_SEARCH_RESULTS.toLocaleString()} products. Refine your filters.` });
        setLoading(false);
        return;
      }

      // Fetch up to 3x the page to compensate for owned-exclusion
      const overFetch = Math.min(perPage * 3, 1000);
      let query = supabase
        .from('keepa_simple_products' as any)
        .select('*', { count: 'exact' });

      query = applyFilters(query);

      query = query.range(from, from + overFetch - 1).order('title', { ascending: true, nullsFirst: false });

      const { data, count, error } = await query;
      if (error) throw error;

      const allFetched = (data as any[] || []) as SimpleProduct[];
      // Exclude owned (permanent ownership exclusion)
      const fresh = allFetched.filter(p => !ownedAsins.has(p.asin));
      const effectiveLimit = Math.min(perPage, maxResults - from);
      const fetchedProducts = fresh.slice(0, effectiveLimit);

      setProducts(fetchedProducts);

      // The whole matching set, used for BOTH the result count and the scan.
      // Collected once: a second pass for the scan would double the reads on a
      // 10,000-row import.
      let allMatching: string[] = [];
      try {
        allMatching = await collectAllMatchingAsins();
      } catch (collectErr) {
        console.warn('[ProductFinder] Full-set collection failed:', collectErr);
      }
      // This used to read `count - ownedAsins.size`, which subtracted the user's
      // TOTAL owned count from the count of rows matching THESE filters -- two
      // different populations. Once more ASINs had been delivered than the
      // filters match, it went negative, and `Page 1 of -4` followed from it.
      // allMatching is the filtered set, so intersecting it with owned is exact.
      const unownedMatching = allMatching.length > 0
        ? allMatching.filter(a => !ownedAsins.has(a)).length
        : Math.max(0, (count ?? 0) - ownedAsins.size);
      setTotalResults(Math.min(unownedMatching, MAX_SEARCH_RESULTS));
      setPage(searchPage);

      if (!fetchedProducts || fetchedProducts.length === 0) {
        toast({ title: "No new products", description: ownedAsins.size > 0
          ? `All matching ASINs are already in your database (${ownedAsins.size.toLocaleString()} owned). Try different filters.`
          : "Try different search terms or import products first." });
      } else {
        // 3. Persist this run + items + owned products
        try {
          const { data: runRow, error: runErr } = await (supabase.from('product_finder_runs' as any) as any)
            .insert({
              user_id: user!.id,
              marketplace: 'US',
              filters_json: { searchText, brandFilter, categoryFilter, page: searchPage },
              result_count: fetchedProducts.length,
            })
            .select('id')
            .single();

          if (!runErr && runRow) {
            const runId = (runRow as any).id;
            const items = fetchedProducts.map((p, idx) => ({
              run_id: runId,
              user_id: user!.id,
              asin: p.asin,
              marketplace: 'US',
              position: from + idx,
            }));
            await (supabase.from('product_finder_run_items' as any) as any).insert(items);

            const owned = fetchedProducts.map(p => ({
              user_id: user!.id,
              asin: p.asin,
              marketplace: 'US',
              title: p.title,
              brand: p.brand,
              category: p.category,
              image_url: p.image_url,
              run_id: runId,
            }));
            await (supabase.from('user_owned_products' as any) as any)
              .upsert(owned, { onConflict: 'user_id,asin,marketplace', ignoreDuplicates: true });
          }
        } catch (persistErr) {
          console.warn('[ProductFinder] Failed to persist run:', persistErr);
        }

        // 4. Show any verdict already on record, then check EVERY matching
        //    product - not just this page. The scan used to be handed
        //    `fetchedProducts`, which is one page of `perPage` (250) rows, so
        //    the progress bar always stopped at 250 no matter how many ASINs
        //    the import held.
        //
        //    forceRescan is NOT set: the function only trusts APPROVED rows
        //    inside its freshness window and re-checks everything else, so a
        //    forced rescan was spending SP-API calls for nothing.
        await loadStoredEligibility(fetchedProducts.map(p => p.asin));
        checkEligibilityProgressive(
          allMatching.length > 0 ? allMatching : fetchedProducts.map(p => p.asin),
        );
      }
    } catch (e: any) {
      toast({ title: "Search failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.xlsx') && !ext.endsWith('.csv') && !ext.endsWith('.xls')) {
      toast({ title: "Invalid file", description: "Please upload an Excel (.xlsx) or CSV (.csv) file.", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Please log in first");

      const formData = new FormData();
      formData.append('file', file);

      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID || 'mstibdszibcheodvnprm';
      const res = await fetch(
        `https://${projectId}.supabase.co/functions/v1/upload-keepa-products`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
          body: formData,
        }
      );

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Upload failed');

      toast({
        title: "Import complete",
        description: `${result.processed} products imported from ${file.name}. ${result.failed > 0 ? `${result.failed} failed.` : ''}`,
      });

      await loadFilterOptions();
      if (searchText || brandFilter !== "all" || categoryFilter !== "all") {
        await handleSearch(0);
      }
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleAsin = (asin: string) => {
    setSelectedAsins(prev => {
      const next = new Set(prev);
      next.has(asin) ? next.delete(asin) : next.add(asin);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedAsins.size === products.length) {
      setSelectedAsins(new Set());
    } else {
      setSelectedAsins(new Set(products.map(p => p.asin)));
    }
  };

  const handleGoogleSingle = async (product: SimpleProduct) => {
    const title = product.title || product.asin;
    try { await navigator.clipboard.writeText(title); } catch {}
    setGoogleSearchingAsin(product.asin);
    try {
      const results = await fetchGoogleShoppingResults(title, product.asin, "auto");
      toast({
        title: "Google search complete",
        description: `Found ${results.length} results for "${title.slice(0, 40)}…". Title copied.`,
      });
    } catch (e: any) {
      toast({ title: "Google search failed", description: e.message, variant: "destructive" });
    } finally {
      setGoogleSearchingAsin(null);
    }
  };

  const handleGoogleBatch = async () => {
    if (selectedAsins.size === 0) {
      toast({ title: "Select products first" });
      return;
    }
    setGoogleSearching(true);
    const selected = products.filter(p => selectedAsins.has(p.asin));
    let ok = 0, fail = 0;
    for (const p of selected) {
      try {
        await fetchGoogleShoppingResults(p.title || p.asin, p.asin, "auto");
        ok++;
      } catch { fail++; }
    }
    setGoogleSearching(false);
    toast({
      title: "Google search complete",
      description: `Searched ${ok} products${fail > 0 ? `, ${fail} failed` : ""}. Check Google Product Search.`,
    });
  };

  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadAll = async () => {
    setDownloading(true);
    try {
      const allRows: any[] = [];
      const batchSize = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from('keepa_simple_products' as any)
          .select('asin, title, brand, category, image_url, imported_at')
          .order('title', { ascending: true, nullsFirst: false })
          // title is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. asin breaks it.
          .order("asin", { ascending: true })
          .range(offset, offset + batchSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows.push(...(data as any[]));
        if (data.length < batchSize) break;
        offset += batchSize;
      }

      if (allRows.length === 0) {
        toast({ title: "No data", description: "No products to download.", variant: "destructive" });
        return;
      }

      const headers = ['ASIN', 'Title', 'Brand', 'Category', 'Image URL', 'Imported At'];
      const escape = (v: any) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...allRows.map(r => [r.asin, r.title, r.brand, r.category, r.image_url, r.imported_at].map(escape).join(','))
      ].join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `product_finder_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: "Download started", description: `${allRows.length.toLocaleString()} products exported to CSV.` });
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const handleDeleteAll = async () => {
    setDeleting(true);
    try {
      const { data, error } = await supabase.rpc('delete_all_keepa_simple_products' as any);
      if (error) throw error;
      setProducts([]);
      setTotalResults(0);
      setSelectedAsins(new Set());
      setEligibilityMap({});
      toast({
        title: "All products deleted",
        description: `${data?.toLocaleString() ?? 0} products removed from the database.`,
      });
      await loadFilterOptions();
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const clearAll = () => {
    setSearchText("");
    setBrandFilter("all");
    setCategoryFilter("all");
    setFbaCompMin("");
    setFbaCompMax("");
    setTotalCompMin("");
    setTotalCompMax("");
    setProducts([]);
    setTotalResults(0);
    setSelectedAsins(new Set());
    setEligibilityMap({});
    setEligibilityProgress(null);
    if (scanAbortRef.current) scanAbortRef.current.abort();
  };

  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalResults) / perPage));

  // Compute summary counts from eligibilityMap
  const eligibilitySummary = (() => {
    const values = Object.values(eligibilityMap);
    return {
      approved: values.filter(v => v === 'approved').length,
      restricted: values.filter(v => v === 'restricted' || v === 'approval_required').length,
      checking: values.filter(v => v === 'checking' || v === 'pending').length,
      errors: values.filter(v => v === 'error').length,
      total: values.length,
    };
  })();

  // Filter products based on approvedOnly toggle
  const displayProducts = approvedOnly
    ? products.filter(p => eligibilityMap[p.asin] === 'approved')
    : products;

  const renderStatusBadge = (asin: string) => {
    const status = eligibilityMap[asin];
    switch (status) {
      case 'checking':
        return (
          <Badge variant="outline" className="text-[10px] px-1.5 animate-pulse">
            <Loader2 className="h-3 w-3 mr-0.5 animate-spin" /> Checking
          </Badge>
        );
      case 'pending':
        return (
          <Badge variant="outline" className="text-[10px] px-1.5 text-muted-foreground">
            Queued
          </Badge>
        );
      case 'approved':
        return (
          <Badge variant="default" className="text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-700">
            <ShieldCheck className="h-3 w-3 mr-0.5" /> Approved
          </Badge>
        );
      case 'restricted':
        return (
          <Badge variant="destructive" className="text-[10px] px-1.5">
            <ShieldX className="h-3 w-3 mr-0.5" /> Restricted
          </Badge>
        );
      case 'approval_required':
        return (
          <Badge variant="secondary" className="text-[10px] px-1.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 mr-0.5" /> Needs Approval
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="secondary" className="text-[10px] px-1.5 text-muted-foreground">
            Error
          </Badge>
        );
      default:
        return <span className="text-xs text-muted-foreground">—</span>;
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Product Finder | InventorySprint</title>
        <meta name="description" content="Search imported Amazon products by ASIN, title, brand, and category" />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-7xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div>
              <h1 className="text-3xl font-bold">Product Finder</h1>
              <p className="text-muted-foreground text-sm">
                Import products from Keepa exports, search &amp; auto-check selling eligibility
              </p>
            </div>
            <div className="flex items-center gap-3">
              {dbStats && (
                <div className="text-xs text-muted-foreground text-right">
                  <div>{dbStats.total.toLocaleString()} products in database</div>
                  {dbStats.lastImport && (
                    <div>Last import: {new Date(dbStats.lastImport).toLocaleDateString()}</div>
                  )}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileUpload}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={deleting || !dbStats || dbStats.total === 0}>
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                    Delete All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete all products?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all {dbStats?.total.toLocaleString()} products from the database. You can re-import from Excel/CSV afterwards.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDeleteAll} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      Yes, delete all
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                onClick={handleDownloadAll}
                disabled={downloading || !dbStats || dbStats.total === 0}
                variant="outline"
                size="sm"
              >
                {downloading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                {downloading ? "Exporting…" : `Download All (${dbStats?.total.toLocaleString() ?? 0})`}
              </Button>
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                variant="outline"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                {uploading ? "Importing…" : "Import Excel/CSV"}
              </Button>
            </div>
          </div>

          {/* Search & Filters */}
          <Card className="p-4 mb-6">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[250px]">
                <Label className="text-xs text-muted-foreground">Search by ASIN, title, or brand</Label>
                <Input
                  placeholder="e.g. B08N5WRWNW or wireless headphones"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  className="h-9"
                  onKeyDown={e => e.key === "Enter" && handleSearch(0)}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Brand</Label>
                <Select value={brandFilter} onValueChange={setBrandFilter}>
                  <SelectTrigger className="w-44 h-9"><SelectValue placeholder="All Brands" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Brands</SelectItem>
                    {brands.map(b => (
                      <SelectItem key={b} value={b}>{b}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Category</Label>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-52 h-9"><SelectValue placeholder="All Categories" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map(c => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">FBA Competitors</Label>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    min={0}
                    placeholder="min"
                    value={fbaCompMin}
                    onChange={e => setFbaCompMin(e.target.value)}
                    className="h-9 w-20"
                    onKeyDown={e => e.key === "Enter" && handleSearch(0)}
                  />
                  <Input
                    type="number"
                    min={0}
                    placeholder="max"
                    value={fbaCompMax}
                    onChange={e => setFbaCompMax(e.target.value)}
                    className="h-9 w-20"
                    onKeyDown={e => e.key === "Enter" && handleSearch(0)}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Total Competitors</Label>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    min={0}
                    placeholder="min"
                    value={totalCompMin}
                    onChange={e => setTotalCompMin(e.target.value)}
                    className="h-9 w-20"
                    onKeyDown={e => e.key === "Enter" && handleSearch(0)}
                  />
                  <Input
                    type="number"
                    min={0}
                    placeholder="max"
                    value={totalCompMax}
                    onChange={e => setTotalCompMax(e.target.value)}
                    className="h-9 w-20"
                    onKeyDown={e => e.key === "Enter" && handleSearch(0)}
                  />
                </div>
              </div>
              <Button onClick={() => handleSearch(0)} disabled={loading} className="h-9">
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
                Find Products
              </Button>
              <Button
                onClick={handleCheckAll}
                disabled={checkingAll || !!eligibilityProgress || !dbStats || dbStats.total === 0}
                variant="secondary"
                className="h-9"
                title="Check selling eligibility for every product matching these filters, not just the current page"
              >
                {checkingAll || eligibilityProgress
                  ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  : <ShieldCheck className="h-4 w-4 mr-1" />}
                Check All{dbStats ? ` (${dbStats.total.toLocaleString()})` : ''}
              </Button>
              <Button onClick={clearAll} variant="ghost" size="sm" className="h-9">
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Clear
              </Button>
              <Button asChild variant="outline" size="sm" className="h-9 ml-auto">
                <a href="/tools/my-database-products">
                  <Database className="h-3.5 w-3.5 mr-1" /> My Database Products
                </a>
              </Button>
            </div>
          </Card>

          {/* Eligibility Progress Bar */}
          {eligibilityProgress && (
            <Card className="p-3 mb-4 border-primary/20 bg-primary/5">
              <div className="flex items-center gap-3 mb-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium">
                  Checking eligibility: {eligibilityProgress.checked.toLocaleString()} / {eligibilityProgress.total.toLocaleString()}
                  {eligibilityProgress.total > products.length && (
                    <span className="text-muted-foreground font-normal">
                      {' '}(whole set - {products.length} shown on this page)
                    </span>
                  )}
                </p>
                {eligibilitySummary.approved > 0 && (
                  <Badge variant="default" className="text-[10px] bg-emerald-600">{eligibilitySummary.approved} approved</Badge>
                )}
                {eligibilitySummary.restricted > 0 && (
                  <Badge variant="destructive" className="text-[10px]">{eligibilitySummary.restricted} restricted</Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Progress value={(eligibilityProgress.checked / eligibilityProgress.total) * 100} className="h-1.5 flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    if (scanAbortRef.current) scanAbortRef.current.abort();
                    setEligibilityProgress(null);
                    setCheckingAll(false);
                  }}
                >
                  Stop
                </Button>
              </div>
            </Card>
          )}

          {/* Summary + Filter toggle (shown after scan completes) */}
          {!eligibilityProgress && eligibilitySummary.total > 0 && (
            <Card className="p-3 mb-4 border-primary/20 bg-primary/5">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3 text-sm">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <span className="font-medium">Eligibility:</span>
                  <Badge variant="default" className="text-[10px] bg-emerald-600">{eligibilitySummary.approved} Approved</Badge>
                  <Badge variant="destructive" className="text-[10px]">{eligibilitySummary.restricted} Restricted</Badge>
                  {eligibilitySummary.errors > 0 && (
                    <Badge variant="secondary" className="text-[10px]">{eligibilitySummary.errors} Errors</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="approved-only"
                    checked={approvedOnly}
                    onCheckedChange={setApprovedOnly}
                  />
                  <Label htmlFor="approved-only" className="text-sm cursor-pointer">
                    Show Approved Only
                  </Label>
                  <Button
                    onClick={handleExportApproved}
                    disabled={exportingApproved}
                    variant="outline"
                    size="sm"
                    className="h-8"
                    title="Download every approved product matching these filters as an Excel file"
                  >
                    {exportingApproved
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                      : <Download className="h-3.5 w-3.5 mr-1" />}
                    Export Approved
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Batch action bar */}
          {displayProducts.length > 0 && (
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div className="text-sm text-muted-foreground">
                {approvedOnly
                  ? `${displayProducts.length} approved · from ${totalResults.toLocaleString()} results`
                  : `${totalResults.toLocaleString()} results`}
                {' '}· Page {page + 1} of {totalPages}
                {selectedAsins.size > 0 && <span className="ml-2 font-medium text-foreground">· {selectedAsins.size} selected</span>}
              </div>
              <Button
                onClick={handleGoogleBatch}
                disabled={selectedAsins.size === 0 || googleSearching}
                variant="default"
                size="sm"
              >
                {googleSearching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ShoppingCart className="h-4 w-4 mr-1" />}
                Find Suppliers ({selectedAsins.size})
              </Button>
            </div>
          )}

          {/* Results table */}
          {displayProducts.length > 0 && (
            <Card>
              <Table containerClassName="max-h-[600px]">
                <TableHeader>
                  <TableRow className="sticky top-0 bg-background z-10">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={selectedAsins.size === displayProducts.length && displayProducts.length > 0}
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead className="w-16">Image</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-center w-20" title="FBA competitors">FBA</TableHead>
                    <TableHead className="text-center w-20" title="Total competitors (new offers)">Total</TableHead>
                    <TableHead className="text-center w-24">Status</TableHead>
                    <TableHead className="text-center w-16">Google</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayProducts.map(p => (
                    <TableRow key={p.asin} className={selectedAsins.has(p.asin) ? "bg-primary/5" : ""}>
                      <TableCell>
                        <Checkbox
                          checked={selectedAsins.has(p.asin)}
                          onCheckedChange={() => toggleAsin(p.asin)}
                        />
                      </TableCell>
                      <TableCell>
                        {p.image_url ? (
                          <img src={p.image_url} alt="" className="w-12 h-12 object-contain rounded" />
                        ) : (
                          <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">N/A</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[300px]">
                        <a
                          href={`https://www.amazon.com/dp/${p.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-primary hover:underline line-clamp-2 leading-tight"
                        >
                          {p.title || p.asin}
                          <ExternalLink className="inline h-3 w-3 ml-1" />
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.asin}</TableCell>
                      <TableCell className="text-xs">{p.brand || "—"}</TableCell>
                      <TableCell className="text-xs">{p.category || "—"}</TableCell>
                      <TableCell className="text-center text-xs font-mono">
                        {p.fba_offer_count ?? "—"}
                      </TableCell>
                      <TableCell className="text-center text-xs font-mono">
                        {p.new_offer_count ?? "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {renderStatusBadge(p.asin)}
                      </TableCell>
                      <TableCell className="text-center">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                disabled={googleSearchingAsin === p.asin}
                                onClick={() => handleGoogleSingle(p)}
                              >
                                {googleSearchingAsin === p.asin ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Globe className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              <p className="text-xs">Copy title & search Google</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            try {
                              const { error } = await supabase
                                .from('keepa_simple_products' as any)
                                .delete()
                                .eq('asin', p.asin);
                              if (error) throw error;
                              setProducts(prev => prev.filter(x => x.asin !== p.asin));
                              setTotalResults(prev => prev - 1);
                              setSelectedAsins(prev => { const n = new Set(prev); n.delete(p.asin); return n; });
                              if (dbStats) setDbStats({ ...dbStats, total: dbStats.total - 1 });
                            } catch (e: any) {
                              toast({ title: "Delete failed", description: e.message, variant: "destructive" });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 p-3 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 0 || loading}
                    onClick={() => handleSearch(page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page + 1 >= totalPages || loading}
                    onClick={() => handleSearch(page + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </Card>
          )}

          {/* Empty state */}
          {!loading && !uploading && products.length === 0 && totalResults === 0 && (
            <div className="text-center py-20 text-muted-foreground">
              <Database className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">Search your product database</p>
              <p className="text-sm mb-4">Import products from Keepa Excel/CSV exports, then search by ASIN, title, brand, or category.</p>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                Import your first file
              </Button>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default KeepaProductFinder;
