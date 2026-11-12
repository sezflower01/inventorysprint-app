import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { isAmazonNotConnected, functionErrorMessage, AMAZON_CONNECT_MESSAGE } from "@/lib/amazonConnection";
import { Plus, Calculator, Download, ExternalLink, Trash2, ArrowUpDown, ArrowUp, ArrowDown, Lock } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface PersonalHourOrder {
  id: string;
  asin: string;
  title: string | null;
  image_url: string | null;
  price: number | null;
  sales_tax: number;
  amazon_fee_fbm: number | null;
  commission: number;
  amount_owed: number | null;
  order_created_date: string;
  settled: boolean;
  buyer_name: string | null;
  cost: number | null;
  created_at: string;
  updated_at: string;
}

// Sales tax rate constant (8.25%)
const SALES_TAX_RATE = 0.0825;

const PersonalHour = () => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<PersonalHourOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<PersonalHourOrder[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [settlementFilter, setSettlementFilter] = useState<string>("not_settled");
  const [asinSearch, setAsinSearch] = useState("");
  
  // Sorting
  const [sortField, setSortField] = useState<string>("order_created_date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  
  // New order form
  const [showNewOrderForm, setShowNewOrderForm] = useState(false);
  const [newOrderAsin, setNewOrderAsin] = useState("");
  const [newOrderDate, setNewOrderDate] = useState<string>(() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const year = now.getFullYear();
    return `${month}-${day}-${year}`;
  });
  const [newOrderCommission, setNewOrderCommission] = useState("");
  const [newOrderBuyerName, setNewOrderBuyerName] = useState("");
  
  // Fetched product data
  const [fetchedTitle, setFetchedTitle] = useState("");
  const [fetchedImage, setFetchedImage] = useState("");
  const [fetchedPrice, setFetchedPrice] = useState("");
  const [fetchedFee, setFetchedFee] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  
  // PIN protection for unsettling orders
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  useEffect(() => {
    if (user) {
      fetchOrders();
    }
  }, [user]);

  useEffect(() => {
    applyFilters();
  }, [orders, dateFrom, dateTo, settlementFilter, asinSearch, sortField, sortDirection]);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("personalhour_orders")
        .select("*")
        .order("order_created_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error: any) {
      toast.error("Failed to fetch orders: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const parseAmericanDate = (dateStr: string): Date | null => {
    if (!dateStr) return null;
    const parts = dateStr.split("-");
    if (parts.length !== 3) return null;
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
    return new Date(year, month - 1, day);
  };

  const parseDbDate = (dateStr: string): Date | null => {
    if (!dateStr) return null;
    const [datePart] = dateStr.split("T");
    const parts = datePart.split("-");
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
    return new Date(year, month - 1, day);
  };

  const formatDbDateToAmerican = (dateStr: string): string => {
    if (!dateStr) return "";
    const [datePart] = dateStr.split("T");
    const parts = datePart.split("-");
    if (parts.length !== 3) return dateStr;
    const [year, month, day] = parts;
    if (!year || !month || !day) return dateStr;
    return `${month.padStart(2, "0")}-${day.padStart(2, "0")}-${year}`;
  };
  const applyFilters = () => {
    let filtered = [...orders];

    // Date range filter
    if (dateFrom) {
      const from = parseAmericanDate(dateFrom);
      if (from && !isNaN(from.getTime())) {
        filtered = filtered.filter(order => {
          const orderDate = parseDbDate(order.order_created_date);
          return orderDate && orderDate >= from;
        });
      }
    }
    if (dateTo) {
      const to = parseAmericanDate(dateTo);
      if (to && !isNaN(to.getTime())) {
        filtered = filtered.filter(order => {
          const orderDate = parseDbDate(order.order_created_date);
          return orderDate && orderDate <= to;
        });
      }
    }

    // Settlement status filter
    if (settlementFilter === "settled") {
      filtered = filtered.filter(order => order.settled);
    } else if (settlementFilter === "not_settled") {
      filtered = filtered.filter(order => !order.settled);
    }

    // ASIN search
    if (asinSearch) {
      filtered = filtered.filter(order => 
        order.asin.toLowerCase().includes(asinSearch.toLowerCase())
      );
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue: any;
      let bValue: any;

      switch (sortField) {
        case "order_created_date": {
          const aDate = parseDbDate(a.order_created_date);
          const bDate = parseDbDate(b.order_created_date);
          aValue = aDate ? aDate.getTime() : 0;
          bValue = bDate ? bDate.getTime() : 0;
          break;
        }
        case "asin":
          aValue = a.asin.toLowerCase();
          bValue = b.asin.toLowerCase();
          break;
        case "price":
          aValue = a.price || 0;
          bValue = b.price || 0;
          break;
        case "amount_owed":
          aValue = a.amount_owed || 0;
          bValue = b.amount_owed || 0;
          break;
        case "settled":
          aValue = a.settled ? 1 : 0;
          bValue = b.settled ? 1 : 0;
          break;
        default:
          aValue = a.order_created_date;
          bValue = b.order_created_date;
      }

      if (aValue < bValue) return sortDirection === "asc" ? -1 : 1;
      if (aValue > bValue) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    setFilteredOrders(filtered);
  };
  const handleSort = (field: string) => {
    if (sortField === field) {
      // Toggle direction if clicking the same field
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      // Set new field with descending as default
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4 ml-1 opacity-50" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="h-4 w-4 ml-1" />
    ) : (
      <ArrowDown className="h-4 w-4 ml-1" />
    );
  };

  // Local-only updates for commission and shipping cost; saved when Calculate is pressed
  const updateLocalOrderField = (orderId: string, field: keyof PersonalHourOrder, value: any) => {
    setOrders((prev) =>
      prev.map((order) =>
        order.id === orderId ? { ...order, [field]: value } : order
      )
    );
  };

  const calculateAndSave = async (orderId: string) => {
    try {
      const order = orders.find(o => o.id === orderId);
      if (!order) return;

      toast.info("Fetching product data from Amazon...");
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Call edge function to get product data
      // Pass existing price as priceOverride so fee calculation works even if Amazon returns NoBuyableOffers
      const { data: productData, error: apiError } = await supabase.functions.invoke(
        'fetch-listing-snapshot',
        {
          body: { asin: order.asin, priceOverride: order.price || 0 },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (apiError) {
        const msg = apiError.message || "";

        // The guard returns 409 AMAZON_NOT_CONNECTED when this account has no
        // Amazon connection of its own. supabase-js puts the real body on
        // error.context, not error.message -- which is always the fixed
        // "non-2xx status code" string -- so without this the user saw that
        // instead of being told what to do. See src/lib/amazonConnection.ts.
        if (await isAmazonNotConnected(apiError)) {
          toast.error(AMAZON_CONNECT_MESSAGE);
          return;
        }

        if (msg.includes("NOT_FOUND")) {
          toast.error(`ASIN ${order.asin} not found in the US marketplace. Order was not updated.`);
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast.error("Amazon SP-API quota exceeded while fetching product data. Please try again later.");
          return;
        }

        toast.error("Failed to update order: " + (await functionErrorMessage(apiError, msg)));
        return;
      }

      if (productData?.error === "QUOTA_EXCEEDED") {
        toast.error("Amazon SP-API quota exceeded while fetching product data. Please try again later.");
        return;
      }

      if (productData?.error === "NOT_FOUND") {
        toast.error(`ASIN ${order.asin} not found in the US marketplace. Order was not updated.`);
        return;
      }

      if (productData?.error === "AMAZON_AUTH_FAILED") {
        toast.error(productData.message || "Amazon authorization failed. Please reconnect Amazon and try again.");
        return;
      }

      if (!productData) {
        toast.error("No product data returned from Amazon for this ASIN.");
        return;
      }

      // Preserve existing values if API doesn't return valid data
      const price = productData.price && productData.price > 0 ? productData.price : (order.price || 0);
      const amazonFee = productData.amazonFeeFbm && productData.amazonFeeFbm > 0 ? productData.amazonFeeFbm : (order.amazon_fee_fbm || 0);
      const commissionPercent = order.commission || 0;
      const salesTax = price * SALES_TAX_RATE; // Auto-calculate sales tax for tracking
      const commissionBase = price - amazonFee;
      const commissionAmount = commissionBase * (commissionPercent / 100);
      const amountOwed = price - amazonFee - commissionAmount; // Amount owed = price - amazon fee - commission

      // Update order in database
      const { error: updateError } = await supabase
        .from("personalhour_orders")
        .update({
          title: productData.title || order.title,
          image_url: productData.imageUrl || order.image_url,
          price: price,
          amazon_fee_fbm: amazonFee,
          sales_tax: salesTax,
          amount_owed: amountOwed,
          commission: commissionPercent,
        })
        .eq("id", orderId);

      if (updateError) throw updateError;

      toast.success("Order updated successfully!");
      await fetchOrders();
    } catch (error: any) {
      toast.error("Failed to update order: " + error.message);
    }
  };

  const recalculateAll = async () => {
    if (!filteredOrders.length) {
      toast.error("No orders to recalculate");
      return;
    }

    if (!confirm(`This will recalculate all ${filteredOrders.length} displayed orders. Continue?`)) {
      return;
    }

    toast.info(`Recalculating ${filteredOrders.length} orders...`);
    let successCount = 0;
    let errorCount = 0;

    for (const order of filteredOrders) {
      try {
        await calculateAndSave(order.id);
        successCount++;
      } catch (error) {
        errorCount++;
      }
    }

    if (errorCount > 0) {
      toast.warning(`Recalculated ${successCount} orders with ${errorCount} errors`);
    } else {
      toast.success(`Successfully recalculated all ${successCount} orders!`);
    }
  };

  const updateOrderField = async (orderId: string, field: string, value: any) => {
    // Check if this is a settled->unsettled transition that requires PIN
    if (field === 'settled') {
      const order = orders.find(o => o.id === orderId);
      if (order && order.settled && value === false) {
        // Trying to change from settled to unsettled - require PIN
        setPendingOrderId(orderId);
        setPendingValue(value);
        setShowPinDialog(true);
        return;
      }
    }
    
    try {
      const { error } = await supabase
        .from("personalhour_orders")
        .update({ [field]: value })
        .eq("id", orderId);

      if (error) throw error;

      await fetchOrders();
    } catch (error: any) {
      toast.error("Failed to update: " + error.message);
    }
  };

  const handlePinSubmit = async () => {
    if (pinValue !== "1365") {
      toast.error("Invalid PIN. Access denied.");
      setPinValue("");
      return;
    }

    // PIN is correct, proceed with the update
    if (pendingOrderId && pendingValue !== null) {
      try {
        const { error } = await supabase
          .from("personalhour_orders")
          .update({ settled: pendingValue })
          .eq("id", pendingOrderId);

        if (error) throw error;

        toast.success("Status updated successfully!");
        await fetchOrders();
      } catch (error: any) {
        toast.error("Failed to update: " + error.message);
      }
    }

    // Reset PIN dialog state
    setShowPinDialog(false);
    setPinValue("");
    setPendingOrderId(null);
    setPendingValue(null);
  };

  const handlePinCancel = () => {
    setShowPinDialog(false);
    setPinValue("");
    setPendingOrderId(null);
    setPendingValue(null);
  };

  const deleteOrder = async (orderId: string) => {
    if (!confirm("Are you sure you want to delete this order? This action cannot be undone.")) {
      return;
    }

    try {
      const { error } = await supabase
        .from("personalhour_orders")
        .delete()
        .eq("id", orderId);

      if (error) throw error;

      toast.success("Order deleted successfully!");
      await fetchOrders();
    } catch (error: any) {
      toast.error("Failed to delete order: " + error.message);
    }
  };

  const fetchProductData = async () => {
    if (!newOrderAsin) {
      toast.error("Please enter an ASIN");
      return;
    }

    try {
      setIsFetching(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data: productData, error: apiError } = await supabase.functions.invoke(
        'fetch-listing-snapshot',
        {
          body: { asin: newOrderAsin.toUpperCase() },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (apiError) {
        const msg = apiError.message || "";

        // The guard returns 409 AMAZON_NOT_CONNECTED when this account has no
        // Amazon connection of its own. supabase-js puts the real body on
        // error.context, not error.message -- which is always the fixed
        // "non-2xx status code" string -- so without this the user saw that
        // instead of being told what to do. See src/lib/amazonConnection.ts.
        if (await isAmazonNotConnected(apiError)) {
          toast.error(AMAZON_CONNECT_MESSAGE);
          return;
        }

        if (msg.includes("NOT_FOUND")) {
          toast.error(`ASIN ${newOrderAsin.toUpperCase()} not found in the US marketplace.`);
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast.error("Amazon SP-API quota exceeded while fetching product data. Please try again later.");
          return;
        }

        throw apiError;
      }

      if (productData?.error === "QUOTA_EXCEEDED") {
        toast.error("Amazon SP-API quota exceeded while fetching product data. Please try again later.");
        return;
      }

      if (productData?.error === "NOT_FOUND") {
        toast.error(`ASIN ${newOrderAsin.toUpperCase()} not found in the US marketplace.`);
        return;
      }

      if (productData?.error === "AMAZON_AUTH_FAILED") {
        toast.error(productData.message || "Amazon authorization failed. Please reconnect Amazon and try again.");
        return;
      }

      if (!productData) {
        toast.error("No product data returned from Amazon for this ASIN.");
        return;
      }

      setFetchedTitle(productData.title || "");
      setFetchedImage(productData.imageUrl || "");
      setFetchedPrice(productData.price?.toString() || "0");
      setFetchedFee(productData.amazonFeeFbm?.toString() || "0");
      toast.success("Product data retrieved!");
    } catch (error: any) {
      toast.error("Failed to fetch product data: " + error.message);
    } finally {
      setIsFetching(false);
    }
  };

  const addNewOrder = async () => {
    if (!newOrderAsin || !newOrderDate || !fetchedTitle) {
      toast.error("Please fetch product data first, then fill in all required fields");
      return;
    }

    // Validate and convert MM-DD-YYYY to YYYY-MM-DD without timezone conversion
    const parts = newOrderDate.split('-');
    if (parts.length !== 3) {
      toast.error("Please enter a valid order date in the format MM-DD-YYYY");
      return;
    }
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    
    if (isNaN(month) || isNaN(day) || isNaN(year) || month < 1 || month > 12 || day < 1 || day > 31) {
      toast.error("Please enter a valid order date in the format MM-DD-YYYY");
      return;
    }
    
    // Convert directly to YYYY-MM-DD format as string (no Date object to avoid timezone issues)
    const formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    try {
      const price = parseFloat(fetchedPrice) || 0;
      const amazonFee = parseFloat(fetchedFee) || 0;
      const salesTax = price * SALES_TAX_RATE; // Auto-calculate sales tax for tracking
      const commissionPercent = parseFloat(newOrderCommission) || 0;
      const commissionBase = price - amazonFee;
      const commissionAmount = commissionBase * (commissionPercent / 100);
      const amountOwed = price - amazonFee - commissionAmount; // Amount owed = price - amazon fee - commission

      const { error } = await supabase
        .from("personalhour_orders")
        .insert({
          user_id: user?.id,
          asin: newOrderAsin.toUpperCase(),
          title: fetchedTitle,
          image_url: fetchedImage,
          price: price,
          amazon_fee_fbm: amazonFee,
          order_created_date: formattedDate,
          sales_tax: salesTax,
          commission: commissionPercent,
          amount_owed: amountOwed,
          buyer_name: newOrderBuyerName || null,
        });

      if (error) throw error;

      toast.success("Order added successfully!");
      setShowNewOrderForm(false);
      setNewOrderAsin("");
      // Reset date to today
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const year = now.getFullYear();
      setNewOrderDate(`${month}-${day}-${year}`);
      setNewOrderCommission("");
      setNewOrderBuyerName("");
      setFetchedTitle("");
      setFetchedImage("");
      setFetchedPrice("");
      setFetchedFee("");
      await fetchOrders();
    } catch (error: any) {
      toast.error("Failed to add order: " + error.message);
    }
  };

  const exportToCSV = () => {
    const headers = ["Order Date", "ASIN", "Title", "Buyer Name", "Price", "Sales Tax", "Amazon FBM Fee", "Commission (%)", "Commission ($)", "Amount Owed", "Settled"];
    
    // Helper function to escape CSV fields
    const escapeCSVField = (field: any): string => {
      if (field === null || field === undefined) return "";
      const stringField = String(field);
      // If field contains comma, quote, or newline, wrap in quotes and escape quotes
      if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
        return `"${stringField.replace(/"/g, '""')}"`;
      }
      return stringField;
    };
    
    // Calculate totals
    let totalPrice = 0;
    let totalSalesTax = 0;
    let totalAmazonFee = 0;
    let totalCommissionDollar = 0;
    let totalAmountOwed = 0;
    
    const rows = filteredOrders.map(order => {
      const price = order.price || 0;
      const amazonFee = order.amazon_fee_fbm || 0;
      const commissionBase = price - amazonFee;
      const commissionAmount = commissionBase * ((order.commission || 0) / 100);
      
      // Add to totals
      totalPrice += price;
      totalSalesTax += order.sales_tax || 0;
      totalAmazonFee += amazonFee;
      totalCommissionDollar += commissionAmount;
      totalAmountOwed += order.amount_owed || 0;
      
      return [
        escapeCSVField(formatDbDateToAmerican(order.order_created_date)),
        escapeCSVField(order.asin),
        escapeCSVField(order.title || ""),
        escapeCSVField(order.buyer_name || ""),
        escapeCSVField((order.price || 0).toFixed(2)),
        escapeCSVField((order.sales_tax || 0).toFixed(2)),
        escapeCSVField((order.amazon_fee_fbm || 0).toFixed(2)),
        escapeCSVField(order.commission || 0),
        escapeCSVField(commissionAmount.toFixed(2)),
        escapeCSVField((order.amount_owed || 0).toFixed(2)),
        escapeCSVField(order.settled ? "Yes" : "No")
      ].join(",");
    });

    // Create totals row
    const totalsRow = [
      escapeCSVField("TOTALS"),
      escapeCSVField(""),
      escapeCSVField(""),
      escapeCSVField(""),
      escapeCSVField(totalPrice.toFixed(2)),
      escapeCSVField(totalSalesTax.toFixed(2)),
      escapeCSVField(totalAmazonFee.toFixed(2)),
      escapeCSVField(""),
      escapeCSVField(totalCommissionDollar.toFixed(2)),
      escapeCSVField(totalAmountOwed.toFixed(2)),
      escapeCSVField("")
    ].join(",");

    // Add empty row for separation
    const emptyRow = Array(11).fill("").join(",");

    const csv = [totalsRow, emptyRow, headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `personalhour-settlement-${format(new Date(), "MM-dd-yyyy")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Report exported!");
  };

  // Calculate totals
  const totalAmountOwed = filteredOrders.reduce((sum, o) => sum + (o.amount_owed || 0), 0);
  const totalSettled = filteredOrders.filter(o => o.settled).reduce((sum, o) => sum + (o.amount_owed || 0), 0);
  const totalNotSettled = filteredOrders.filter(o => !o.settled).reduce((sum, o) => sum + (o.amount_owed || 0), 0);

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-cyan-50 via-blue-50 to-teal-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800">
        <Navbar />
        <main className="flex-grow pt-24 pb-12 flex items-center justify-center px-4">
          <Card className="max-w-md w-full bg-white/80 dark:bg-gray-800/80 backdrop-blur border-cyan-200 dark:border-cyan-900">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
                PersonalHour Settlement Access
              </CardTitle>
              <CardDescription>
                Please log in or create an account to access PersonalHour Settlement
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button 
                onClick={() => window.location.href = '/login'} 
                className="w-full bg-cyan-600 hover:bg-cyan-700"
              >
                Log In
              </Button>
              <Button 
                onClick={() => window.location.href = '/signup'} 
                variant="outline"
                className="w-full"
              >
                Create Account
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-cyan-50 via-blue-50 to-teal-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800">
      <Helmet>
        <title>PersonalHour Settlement | InventorySprint</title>
        <meta name="description" content="Track and manage PersonalHour Amazon FBM orders and settlements" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="px-2 max-w-full">
          {/* Header */}
          <div className="mb-8 px-2">
            <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
              PersonalHour Settlement
            </h1>
            <p className="text-muted-foreground">Track Amazon FBM orders and calculate what Pedu owes PersonalHour</p>
          </div>

          {/* Filters Bar */}
          <Card className="mb-6 bg-white/80 dark:bg-gray-800/80 backdrop-blur border-cyan-200 dark:border-cyan-900">
            <CardHeader>
              <CardTitle className="text-lg">Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">From Date (MM-DD-YYYY)</label>
                  <Input
                    placeholder="MM-DD-YYYY"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
 
                <div>
                   <label className="text-sm font-medium mb-2 block">To Date (MM-DD-YYYY)</label>
                   <Input
                     placeholder="MM-DD-YYYY"
                     value={dateTo}
                     onChange={(e) => setDateTo(e.target.value)}
                   />
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Settlement Status</label>
                  <Select value={settlementFilter} onValueChange={setSettlementFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="settled">Settled</SelectItem>
                      <SelectItem value="not_settled">Not Settled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Search ASIN</label>
                  <Input
                    placeholder="Enter ASIN..."
                    value={asinSearch}
                    onChange={(e) => setAsinSearch(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                <Button onClick={() => setShowNewOrderForm(!showNewOrderForm)} className="bg-cyan-600 hover:bg-cyan-700">
                  <Plus className="mr-2 h-4 w-4" />
                  Add New Order
                </Button>
                <Button onClick={exportToCSV} variant="outline">
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* New Order Form */}
          {showNewOrderForm && (
            <Card className="mb-6 bg-cyan-50 dark:bg-cyan-900/20 border-cyan-300 dark:border-cyan-700">
              <CardHeader>
                <CardTitle className="text-lg">Add New Order</CardTitle>
                <CardDescription>Step 1: Enter ASIN and fetch product data. Step 2: Review and edit if needed. Step 3: Add order details.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Step 1: Fetch Product Data */}
                <div className="flex gap-2">
                  <Input 
                    placeholder="Enter ASIN" 
                    value={newOrderAsin} 
                    onChange={(e) => setNewOrderAsin(e.target.value)}
                    className="flex-1"
                  />
                  <Button 
                    onClick={fetchProductData} 
                    disabled={isFetching || !newOrderAsin}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {isFetching ? "Fetching..." : "Fetch Product"}
                  </Button>
                </div>

                {/* Step 2: Display Fetched Data (if available) */}
                {fetchedTitle && (
                  <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border border-cyan-200 dark:border-cyan-700 space-y-3">
                    <div className="flex gap-4 items-start">
                      {fetchedImage && (
                        <img src={fetchedImage} alt={fetchedTitle} className="w-20 h-20 object-cover rounded" />
                      )}
                      <div className="flex-1">
                        <p className="font-medium text-sm mb-2">{fetchedTitle}</p>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <label className="text-muted-foreground block mb-1">Price (editable)</label>
                            <Input 
                              type="number" 
                              step="0.01" 
                              value={fetchedPrice} 
                              onChange={(e) => setFetchedPrice(e.target.value)}
                              className="h-8"
                            />
                          </div>
                          <div>
                            <label className="text-muted-foreground block mb-1">FBM Fee</label>
                            <Input 
                              type="number" 
                              step="0.01" 
                              value={fetchedFee} 
                              disabled
                              className="h-8 bg-muted"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Step 3: Order Details */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-3 border-t">
                      <Input 
                        placeholder="Buyer Name" 
                        value={newOrderBuyerName} 
                        onChange={(e) => setNewOrderBuyerName(e.target.value)}
                      />
                      <div className="relative">
                        <Input
                          placeholder="Order Date (MM-DD-YYYY)"
                          value={newOrderDate}
                          onChange={(e) => setNewOrderDate(e.target.value)}
                          className={!newOrderDate ? "border-red-300" : ""}
                        />
                        {!newOrderDate && (
                          <span className="absolute -top-2 right-2 text-red-500 text-xs">Required</span>
                        )}
                      </div>
                      <Input 
                        placeholder="Commission (%)" 
                        type="number" 
                        step="0.1" 
                        value={newOrderCommission} 
                        onChange={(e) => setNewOrderCommission(e.target.value)} 
                      />
                      <Button onClick={addNewOrder} className="bg-cyan-600 hover:bg-cyan-700">
                        Add Order
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Orders Table */}
          <Card className="mb-6 bg-white/80 dark:bg-gray-800/80 backdrop-blur border-cyan-200 dark:border-cyan-900">
            <CardContent className="p-6">
              {loading ? (
                <div className="text-center py-8 text-muted-foreground">Loading orders...</div>
              ) : filteredOrders.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No orders found. Add your first order to get started!</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead 
                          className="cursor-pointer hover:bg-muted/50 select-none"
                          onClick={() => handleSort("order_created_date")}
                        >
                          <div className="flex items-center">
                            Order Date
                            <SortIcon field="order_created_date" />
                          </div>
                        </TableHead>
                        <TableHead>Image</TableHead>
                        <TableHead 
                          className="cursor-pointer hover:bg-muted/50 select-none"
                          onClick={() => handleSort("asin")}
                        >
                          <div className="flex items-center">
                            ASIN
                            <SortIcon field="asin" />
                          </div>
                        </TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead>Buyer</TableHead>
                        <TableHead 
                          className="cursor-pointer hover:bg-muted/50 select-none"
                          onClick={() => handleSort("price")}
                        >
                          <div className="flex items-center">
                            Price
                            <SortIcon field="price" />
                          </div>
                        </TableHead>
                        <TableHead>Sales Tax</TableHead>
                        <TableHead>FBM Fee</TableHead>
                        <TableHead>Commission (%)</TableHead>
                        <TableHead>Commission ($)</TableHead>
                        <TableHead 
                          className="cursor-pointer hover:bg-muted/50 select-none"
                          onClick={() => handleSort("amount_owed")}
                        >
                          <div className="flex items-center">
                            Amount Owed
                            <SortIcon field="amount_owed" />
                          </div>
                        </TableHead>
                        <TableHead>ROI %</TableHead>
                        <TableHead 
                          className="cursor-pointer hover:bg-muted/50 select-none"
                          onClick={() => handleSort("settled")}
                        >
                          <div className="flex items-center">
                            Status
                            <SortIcon field="settled" />
                          </div>
                        </TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredOrders.map((order) => (
                        <TableRow key={order.id}>
                          <TableCell>{formatDbDateToAmerican(order.order_created_date)}</TableCell>
                          <TableCell>
                            {order.image_url ? (
                              <img src={order.image_url} alt={order.title || ""} className="w-12 h-12 object-cover rounded" />
                            ) : (
                              <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs">No image</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <a
                              href={`https://amazon.com/dp/${order.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-600 hover:underline flex items-center gap-1"
                            >
                              {order.asin}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </TableCell>
                          <TableCell className="max-w-xs truncate">{order.title || "—"}</TableCell>
                          <TableCell>
                            <Input
                              placeholder="Buyer name"
                              value={order.buyer_name || ""}
                              onChange={(e) => updateOrderField(order.id, 'buyer_name', e.target.value)}
                              className="w-32"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              step="0.01"
                              value={order.price || 0}
                              onChange={(e) => updateLocalOrderField(order.id, 'price', parseFloat(e.target.value) || 0)}
                              className="w-24"
                            />
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            ${order.sales_tax?.toFixed(2) || "0.00"}
                            <span className="text-xs block">(8.25% auto)</span>
                          </TableCell>
                          <TableCell>${order.amazon_fee_fbm?.toFixed(2) || "0.00"}</TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              step="0.1"
                              value={order.commission}
                              onChange={(e) => updateLocalOrderField(order.id, 'commission', parseFloat(e.target.value) || 0)}
                              className="w-24"
                            />
                          </TableCell>
                          <TableCell className="font-medium text-blue-600 dark:text-blue-400">
                            ${(() => {
                              const price = order.price || 0;
                              const amazonFee = order.amazon_fee_fbm || 0;
                              const commissionBase = price - amazonFee;
                              const commissionAmount = commissionBase * ((order.commission || 0) / 100);
                              return commissionAmount.toFixed(2);
                            })()}
                          </TableCell>
                          <TableCell className="font-bold text-cyan-700 dark:text-cyan-400">
                            ${order.amount_owed?.toFixed(2) || "0.00"}
                          </TableCell>
                          <TableCell className="font-medium">
                            {(() => {
                              const amountOwed = order.amount_owed;
                              if (!amountOwed || amountOwed <= 0) return "—";
                              const price = order.price || 0;
                              const amazonFee = order.amazon_fee_fbm || 0;
                              const commissionBase = price - amazonFee;
                              const commissionAmount = commissionBase * ((order.commission || 0) / 100);
                              if (commissionAmount <= 0) return "—";
                              const roi = (commissionAmount / amountOwed) * 100;
                              return (
                                <span className={roi >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                                  {roi.toFixed(1)}%
                                </span>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={order.settled ? "settled" : "not_settled"}
                              onValueChange={(value) => updateOrderField(order.id, 'settled', value === "settled")}
                            >
                              <SelectTrigger className="w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="settled">Settled</SelectItem>
                                <SelectItem value="not_settled">Not Settled</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => calculateAndSave(order.id)}
                                className="bg-cyan-600 hover:bg-cyan-700"
                              >
                                <Calculator className="h-4 w-4 mr-1" />
                                Calculate
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => deleteOrder(order.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Totals Summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="bg-gradient-to-br from-cyan-500 to-blue-600 text-white border-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Total Amount Owed</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">${totalAmountOwed.toFixed(2)}</p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-green-500 to-emerald-600 text-white border-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Settled</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">${totalSettled.toFixed(2)}</p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-orange-500 to-red-600 text-white border-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Not Settled</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">${totalNotSettled.toFixed(2)}</p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-purple-500 to-pink-600 text-white border-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{filteredOrders.length}</p>
              </CardContent>
            </Card>
          </div>

          {/* Recalculate All Button */}
          <div className="flex justify-center mt-6">
            <Button
              onClick={recalculateAll}
              size="lg"
              className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-semibold px-8 py-6 text-lg"
            >
              <Calculator className="h-5 w-5 mr-2" />
              Recalculate All Records
            </Button>
          </div>
        </div>
      </main>
      
      <Footer />

      {/* PIN Protection Dialog */}
      <Dialog open={showPinDialog} onOpenChange={(open) => !open && handlePinCancel()}>
        <DialogContent className="sm:max-w-md bg-gradient-to-br from-orange-50 to-red-50 dark:from-orange-950 dark:to-red-950 border-2 border-red-300 dark:border-red-700">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
              <Lock className="h-5 w-5" />
              PIN Required to Undo Settlement
            </DialogTitle>
            <DialogDescription className="text-base">
              Enter PIN to change status from Settled to Not Settled.
              <br />
              <span className="font-medium">If you don't have it, contact Administrator.</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              type="password"
              placeholder="Enter 4-digit PIN"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handlePinSubmit();
                }
              }}
              className="text-center text-2xl tracking-widest font-mono"
              maxLength={4}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={handlePinCancel}>
                Cancel
              </Button>
              <Button 
                onClick={handlePinSubmit}
                className="bg-red-600 hover:bg-red-700"
                disabled={pinValue.length !== 4}
              >
                Submit PIN
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PersonalHour;
