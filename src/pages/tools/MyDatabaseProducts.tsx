import { useEffect, useState, useCallback, useRef } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, ExternalLink, Trash2, Database, ChevronLeft, ChevronRight, Download, RefreshCw, CheckCircle2, XCircle, AlertTriangle, HelpCircle, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

interface OwnedProduct {
  id: string;
  asin: string;
  marketplace: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  image_url: string | null;
  buy_box_price: number | null;
  sales_rank: number | null;
  monthly_sold: number | null;
  score: number | null;
  delivered_at: string;
  eligibility_status: string | null;
  eligibility_checked_at: string | null;
}

type EligibilityStatus = 'pending' | 'checking' | 'approved' | 'approval_required' | 'restricted' | 'error';

const PAGE_SIZE = 100;
const ELIG_BATCH = 10;

const MyDatabaseProducts = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState<OwnedProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [eligibilityMap, setEligibilityMap] = useState<Record<string, EligibilityStatus>>({});
  const [eligProgress, setEligProgress] = useState<{ checked: number; total: number } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'approval_required' | 'restricted'>('all');
  const scanAbortRef = useRef<AbortController | null>(null);

  const persistStatuses = useCallback(async (updates: { asin: string; status: EligibilityStatus }[]) => {
    if (!user || updates.length === 0) return;
    const checkedAt = new Date().toISOString();
    // Update each row by (user_id, asin) — small batch, fire in parallel
    await Promise.all(updates.map(u =>
      (supabase.from('user_owned_products' as any) as any)
        .update({ eligibility_status: u.status, eligibility_checked_at: checkedAt })
        .eq('user_id', user.id)
        .eq('asin', u.asin)
    ));
  }, [user]);

  const checkEligibility = useCallback(async (asins: string[], opts?: { force?: boolean }) => {
    if (!user || asins.length === 0) return;
    if (scanAbortRef.current) scanAbortRef.current.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    setEligibilityMap(prev => {
      const next = { ...prev };
      asins.forEach(a => { if (!next[a] || next[a] === 'error') next[a] = 'pending'; });
      return next;
    });
    setEligProgress({ checked: 0, total: asins.length });

    let checked = 0;
    for (let i = 0; i < asins.length; i += ELIG_BATCH) {
      if (controller.signal.aborted) return;
      const batch = asins.slice(i, i + ELIG_BATCH);
      setEligibilityMap(prev => {
        const next = { ...prev };
        batch.forEach(a => { next[a] = 'checking'; });
        return next;
      });

      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: batch, force_rescan: !!opts?.force },
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
          const persistList: { asin: string; status: EligibilityStatus }[] = [];
          setEligibilityMap(prev => {
            const next = { ...prev };
            for (const r of results) {
              const mapped: EligibilityStatus = r.status === 'approved' ? 'approved'
                : r.status === 'approval_required' ? 'approval_required'
                : r.status === 'restricted' ? 'restricted'
                : 'error';
              next[r.asin] = mapped;
              if (mapped !== 'error') persistList.push({ asin: r.asin, status: mapped });
            }
            for (const a of batch) {
              if (!next[a] || next[a] === 'checking') next[a] = 'error';
            }
            return next;
          });
          // Persist successful checks to DB so status survives reloads
          if (persistList.length > 0) {
            persistStatuses(persistList).catch(() => {});
          }
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
      setEligProgress({ checked: Math.min(checked, asins.length), total: asins.length });
    }
    setEligProgress(null);
  }, [user, persistStatuses]);

  const load = useCallback(async (p: number, q: string) => {
    if (!user) return;
    setLoading(true);
    try {
      let query = (supabase.from('user_owned_products' as any) as any)
        .select('*', { count: 'exact' })
        .eq('user_id', user.id)
        // delivered_at is NULL on many rows, so on its own it is not an order
        // at all for those: paging a tie block repeats some rows on one page
        // and loses others entirely. id makes it total while leaving
        // newest-delivered-first as the visible sort.
        .order('delivered_at', { ascending: false })
        .order('id', { ascending: true });

      if (q.trim()) {
        const term = q.trim();
        if (/^[A-Z0-9]{10}$/i.test(term)) {
          query = query.ilike('asin', term);
        } else {
          query = query.or(`title.ilike.%${term}%,brand.ilike.%${term}%,asin.ilike.%${term}%`);
        }
      }

      const from = p * PAGE_SIZE;
      query = query.range(from, from + PAGE_SIZE - 1);

      const { data, count, error } = await query;
      if (error) throw error;
      const list = (data as any[] || []) as OwnedProduct[];
      setProducts(list);
      setTotal(count ?? 0);
      setPage(p);

      // Hydrate the eligibility map from cached DB values, then re-check only the missing ones
      const cachedMap: Record<string, EligibilityStatus> = {};
      const needCheck: string[] = [];
      for (const row of list) {
        const cached = row.eligibility_status as EligibilityStatus | null;
        if (cached === 'approved' || cached === 'approval_required' || cached === 'restricted') {
          cachedMap[row.asin] = cached;
        } else {
          needCheck.push(row.asin);
        }
      }
      setEligibilityMap(prev => ({ ...prev, ...cachedMap }));
      if (needCheck.length > 0) {
        checkEligibility(needCheck);
      }
    } catch (e: any) {
      toast({ title: "Load failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [user, toast, checkEligibility]);

  useEffect(() => { load(0, ""); }, [load]);


  const handleDelete = async (id: string, asin: string) => {
    try {
      const { error } = await (supabase.from('user_owned_products' as any) as any).delete().eq('id', id);
      if (error) throw error;
      setProducts(prev => prev.filter(p => p.id !== id));
      setTotal(t => t - 1);
      toast({ title: "Removed", description: `${asin} removed — it can now appear again in Find Products.` });
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  };

  const handleDeleteAll = async () => {
    if (!user) return;
    try {
      const { error } = await (supabase.from('user_owned_products' as any) as any)
        .delete()
        .eq('user_id', user.id);
      if (error) throw error;
      setProducts([]);
      setTotal(0);
      toast({ title: "Database cleared", description: "All ASINs removed from your database." });
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  };

  const handleExport = async () => {
    if (!user) return;
    try {
      const all: OwnedProduct[] = [];
      let offset = 0;
      const batch = 1000;
      while (true) {
        const { data, error } = await (supabase.from('user_owned_products' as any) as any)
          .select('*')
          .eq('user_id', user.id)
          .order('delivered_at', { ascending: false })
          // delivered_at is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(offset, offset + batch - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as any[]));
        if (data.length < batch) break;
        offset += batch;
      }
      const headers = ['ASIN', 'Title', 'Brand', 'Category', 'Marketplace', 'Status', 'Delivered At'];
      const esc = (v: any) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...all.map(r => [r.asin, r.title, r.brand, r.category, r.marketplace, eligibilityMap[r.asin] || 'unknown', r.delivered_at].map(esc).join(',')),
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my_database_products_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `${all.length.toLocaleString()} products exported.` });
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const renderStatus = (asin: string) => {
    const s = eligibilityMap[asin];
    switch (s) {
      case 'approved':
        return <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-600 border-green-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />Approved</Badge>;
      case 'approval_required':
        return <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/30"><AlertTriangle className="h-3 w-3 mr-1" />Approval req.</Badge>;
      case 'restricted':
        return <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-600 border-red-500/30"><XCircle className="h-3 w-3 mr-1" />Restricted</Badge>;
      case 'checking':
        return <Badge variant="outline" className="text-[10px]"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Checking</Badge>;
      case 'pending':
        return <Badge variant="outline" className="text-[10px] text-muted-foreground">Queued</Badge>;
      case 'error':
        return <Badge variant="outline" className="text-[10px] text-muted-foreground"><HelpCircle className="h-3 w-3 mr-1" />N/A</Badge>;
      default:
        return <Badge variant="outline" className="text-[10px] text-muted-foreground">—</Badge>;
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>My Database Products | InventorySprint</title>
        <meta name="description" content="Your permanent personal database of ASINs delivered from Find Products." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-7xl">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div className="flex items-start gap-3">
              <Button variant="ghost" size="icon" asChild className="mt-1 h-8 w-8" title="Back to Find Products">
                <Link to="/tools/product-finder">
                  <ArrowLeft className="h-5 w-5" />
                </Link>
              </Button>
              <div>
                <h1 className="text-3xl font-bold">My Database Products</h1>
                <p className="text-muted-foreground text-sm">
                  Permanent personal database of ASINs delivered from Find Products. {total.toLocaleString()} owned.
                  {eligProgress && (
                    <span className="ml-2 text-primary">
                      Checking eligibility… {eligProgress.checked}/{eligProgress.total}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => products.length > 0 && checkEligibility(products.map(p => p.asin), { force: true })}
                disabled={products.length === 0 || !!eligProgress}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${eligProgress ? 'animate-spin' : ''}`} /> Recheck Status
              </Button>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={total === 0}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={total === 0}>
                    <Trash2 className="h-4 w-4 mr-2" /> Clear All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear your entire database?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes all {total.toLocaleString()} owned ASINs. They will become eligible to appear again in Find Products.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDeleteAll} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      Yes, clear all
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          <Card className="p-4 mb-6">
            <div className="flex gap-2">
              <Input
                placeholder="Search ASIN, title, or brand…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (setSearch(searchInput), load(0, searchInput))}
                className="h-9"
              />
              <Button size="sm" className="h-9" onClick={() => { setSearch(searchInput); load(0, searchInput); }}>
                <Search className="h-4 w-4 mr-1" /> Search
              </Button>
              {search && (
                <Button size="sm" variant="ghost" className="h-9" onClick={() => { setSearch(""); setSearchInput(""); load(0, ""); }}>
                  Clear
                </Button>
              )}
            </div>
          </Card>

          {(() => {
            const counts = products.reduce(
              (acc, p) => {
                const s = eligibilityMap[p.asin];
                if (s === 'approved') acc.approved++;
                else if (s === 'approval_required') acc.approval_required++;
                else if (s === 'restricted') acc.restricted++;
                return acc;
              },
              { approved: 0, approval_required: 0, restricted: 0 }
            );
            const filterChip = (
              key: typeof statusFilter,
              label: string,
              count: number,
              activeCls: string,
              idleCls: string,
              Icon: typeof CheckCircle2
            ) => {
              const active = statusFilter === key;
              return (
                <Badge
                  variant="outline"
                  onClick={() => setStatusFilter(active ? 'all' : key)}
                  className={`cursor-pointer select-none text-xs px-2.5 py-1 transition-colors ${active ? activeCls : idleCls}`}
                >
                  <Icon className="h-3 w-3 mr-1" />
                  {label} <span className="ml-1 opacity-70">({count})</span>
                </Badge>
              );
            };
            return (
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="text-xs text-muted-foreground mr-1">Filter by status:</span>
                {filterChip('approved', 'Approved', counts.approved,
                  'bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/50',
                  'bg-green-500/5 text-green-600 border-green-500/30 hover:bg-green-500/10',
                  CheckCircle2)}
                {filterChip('approval_required', 'Approval required', counts.approval_required,
                  'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/50',
                  'bg-amber-500/5 text-amber-600 border-amber-500/30 hover:bg-amber-500/10',
                  AlertTriangle)}
                {filterChip('restricted', 'Restricted', counts.restricted,
                  'bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/50',
                  'bg-red-500/5 text-red-600 border-red-500/30 hover:bg-red-500/10',
                  XCircle)}
                {statusFilter !== 'all' && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setStatusFilter('all')}>
                    Clear filter
                  </Button>
                )}
              </div>
            );
          })()}

          {loading ? (
            <div className="text-center py-20 text-muted-foreground">
              <Loader2 className="h-8 w-8 mx-auto animate-spin" />
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <Database className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">No products in your database yet</p>
              <p className="text-sm">Run Find Products to start building your personal ASIN database.</p>
            </div>
          ) : (
            <Card>
              <Table containerClassName="max-h-[700px]">
                <TableHeader>
                  <TableRow className="sticky top-0 bg-background z-10">
                    <TableHead className="w-16">Image</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Delivered</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products
                    .filter(p => statusFilter === 'all' || eligibilityMap[p.asin] === statusFilter)
                    .map(p => (
                    <TableRow key={p.id}>
                      <TableCell>
                        {p.image_url ? (
                          <img src={p.image_url} alt="" className="w-12 h-12 object-contain rounded" />
                        ) : (
                          <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">N/A</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[320px]">
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
                      <TableCell>{renderStatus(p.asin)}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-[10px]">
                          {new Date(p.delivered_at).toLocaleDateString()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(p.id, p.asin)}
                          title="Remove from my database (allows it to appear again)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 p-3 border-t">
                  <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => load(page - 1, search)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">Page {page + 1} of {totalPages}</span>
                  <Button size="sm" variant="outline" disabled={page + 1 >= totalPages || loading} onClick={() => load(page + 1, search)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default MyDatabaseProducts;
