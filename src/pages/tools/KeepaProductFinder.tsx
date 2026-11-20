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

const BATCH_SIZE = 5;

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
  const checkEligibilityProgressive = useCallback(async (productList: SimpleProduct[]) => {
    if (!user || productList.length === 0) return;

    // Cancel any previous scan
    if (scanAbortRef.current) scanAbortRef.current.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    const asins = productList.map(p => p.asin);

    // Set all to 'pending' initially
    const initialMap: Record<string, EligibilityStatus> = {};
    asins.forEach(a => { initialMap[a] = 'pending'; });
    setEligibilityMap(initialMap);
    setEligibilityProgress({ checked: 0, total: asins.length });

    let checked = 0;

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < asins.length; i += BATCH_SIZE) {
      if (controller.signal.aborted) return;

      const batch = asins.slice(i, i + BATCH_SIZE);

      // Mark this batch as 'checking'
      setEligibilityMap(prev => {
        const next = { ...prev };
        batch.forEach(a => { next[a] = 'checking'; });
        return next;
      });

      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: batch, force_rescan: true },
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
    }

    setEligibilityProgress(null);
  }, [user]);

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

  const handleSearch = async (searchPage = 0) => {
    setLoading(true);
    setSelectedAsins(new Set());
    // Cancel any ongoing scan
    if (scanAbortRef.current) scanAbortRef.current.abort();
    setEligibilityMap({});
    setEligibilityProgress(null);

    try {
      // 1. Load owned ASINs (permanent exclusion)
      const ownedAsins = await fetchOwnedAsins();

      // 2. Build query, fetch a wider pool then filter out owned client-side
      //    (Postgres NOT IN with thousands of values is fragile; client-side filter is safer)
      const maxResults = 500;
      const from = searchPage * perPage;
      if (from >= maxResults) {
        setProducts([]);
        toast({ title: "Limit reached", description: "Maximum 500 products per search. Refine your filters." });
        setLoading(false);
        return;
      }

      // Fetch up to 3x the page to compensate for owned-exclusion
      const overFetch = Math.min(perPage * 3, 1000);
      let query = supabase
        .from('keepa_simple_products' as any)
        .select('*', { count: 'exact' });

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

      query = query.range(from, from + overFetch - 1).order('title', { ascending: true, nullsFirst: false });

      const { data, count, error } = await query;
      if (error) throw error;

      const allFetched = (data as any[] || []) as SimpleProduct[];
      // Exclude owned (permanent ownership exclusion)
      const fresh = allFetched.filter(p => !ownedAsins.has(p.asin));
      const effectiveLimit = Math.min(perPage, maxResults - from);
      const fetchedProducts = fresh.slice(0, effectiveLimit);

      setProducts(fetchedProducts);
      // Display total minus owned (approximation — actual unowned count requires server filter)
      setTotalResults(Math.min((count ?? 0) - ownedAsins.size, 500));
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

        // 4. Auto-start eligibility checking for the loaded page
        checkEligibilityProgressive(fetchedProducts);
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

  const totalPages = Math.ceil(totalResults / perPage);

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
                  Checking eligibility: {eligibilityProgress.checked} / {eligibilityProgress.total}
                </p>
                {eligibilitySummary.approved > 0 && (
                  <Badge variant="default" className="text-[10px] bg-emerald-600">{eligibilitySummary.approved} approved</Badge>
                )}
                {eligibilitySummary.restricted > 0 && (
                  <Badge variant="destructive" className="text-[10px]">{eligibilitySummary.restricted} restricted</Badge>
                )}
              </div>
              <Progress value={(eligibilityProgress.checked / eligibilityProgress.total) * 100} className="h-1.5" />
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
