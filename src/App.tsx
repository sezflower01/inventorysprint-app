import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { UiModeProvider } from "@/contexts/UiModeContext";
import { SalesSyncProvider } from "@/contexts/SalesSyncContext";
import { isStaleChunkError, reloadOnceForStaleChunk } from "@/lib/staleChunk";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { AppVersionGate } from "@/components/AppVersionGate";
import { Suspense, lazy, Component, ReactNode, ComponentType } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

// Stale-chunk error detection, shared by lazyWithRetry and LazyErrorBoundary
// so the two can't drift out of sync with each other again. Browsers phrase
// a failed dynamic import differently: Chrome/Edge say "Failed to fetch
// dynamically imported module", Safari says "Importing a module script
// failed", Firefox says "error loading dynamically imported module" (was
// missing here entirely — the most likely reason some mobile browsers fell
// through to the manual "Hard Refresh" button instead of auto-recovering).
// Also covers Vite's CSS-chunk failure message and an older webpack-style
// "Loading chunk" string for safety.
// isStaleChunkError and reloadOnceForStaleChunk now live in
// @/lib/staleChunk so non-component dynamic imports can use them too --
// the exceljs import behind "Export Excel" could not reach them here and
// failed outright on a tab left open across a deploy.

// Retry wrapper for lazy imports - handles stale chunk errors after HMR/deployments
function lazyWithRetry<T extends ComponentType<unknown>>(
  importFn: () => Promise<{ default: T }>,
  retries = 2
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await importFn();
      } catch (error) {
        const isChunkError = isStaleChunkError(error);

        if (isChunkError && attempt < retries) {
          // Wait briefly then retry
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // On final failure for chunk errors, force reload to get fresh chunks
        if (isChunkError && reloadOnceForStaleChunk()) {
          console.warn('Chunk load failed after retries, reloading page...');
          // Return a dummy component while reload happens
          return { default: (() => null) as unknown as T };
        }

        throw error;
      }
    }
    throw new Error('Import failed after retries');
  });
}

// Error boundary for lazy loaded components with retry capability
class LazyErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { hasError: boolean; retryKey: number }> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false, retryKey: 0 };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error('Lazy load error:', error);
    // Auto-reload on chunk errors (same detection + one-shot guard as lazyWithRetry)
    if (isStaleChunkError(error)) {
      reloadOnceForStaleChunk();
    }
  }
  handleRetry = () => {
    this.setState(prev => ({ hasError: false, retryKey: prev.retryKey + 1 }));
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
          <p className="text-red-500">Failed to load page.</p>
          <div className="flex gap-3">
            <button 
              onClick={this.handleRetry} 
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Try Again
            </button>
            <button 
              onClick={() => window.location.reload()} 
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Hard Refresh
            </button>
          </div>
        </div>
      );
    }
    return <div key={this.state.retryKey}>{this.props.children}</div>;
  }
}

// Basic pages (always loaded)
import Index from "./pages/Index";
import BlogAiRepricer from "./pages/BlogAiRepricer";
import BlogRealAiDecisions from "./pages/BlogRealAiDecisions";
import BlogAiRepricerLooksAt from "./pages/BlogAiRepricerLooksAt";
import BlogProductLibrary from "./pages/BlogProductLibrary";
import BlogRepricerFeatures from "./pages/BlogRepricerFeatures";
import BlogWhatRepricerDoes from "./pages/BlogWhatRepricerDoes";
import BlogTwoSellersOneAsin from "./pages/BlogTwoSellersOneAsin";
import BlogArbitrageVsWholesaleRepricing from "./pages/BlogArbitrageVsWholesaleRepricing";

import Contact from "./pages/Contact";
import Support from "./pages/Support";
import About from "./pages/About";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsOfService from "./pages/TermsOfService";
import BuyLicense from "./pages/BuyLicense";
import AiRepricerProduct from "./pages/AiRepricerProduct";
import ProductLibraryProduct from "./pages/ProductLibraryProduct";
import ModuleExplainer from "./pages/ModuleExplainer";
import Pricing from "./pages/Pricing";
import NotFound from "./pages/NotFound";
import SignUp from "./pages/SignUp";
import Login from "./pages/Login";
import AuthCallback from "./pages/AuthCallback";
import CompleteProfile from "./pages/CompleteProfile";
import SignedIn from "./pages/SignedIn";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import ProtectedRoute from "./components/ProtectedRoute";
import PersonalHour from "./pages/PersonalHour";
import { ModuleGuard } from "./components/access/ModuleGuard";
import Diagnostics from "./pages/Diagnostics";
import Settings from "./pages/Settings";
import AdminDownload from "./pages/AdminDownload";
import Subscriptions from "./pages/Subscriptions";
import DesktopOnlyWidgets from "./components/DesktopOnlyWidgets";
import GlobalErrorInterceptor from "./components/GlobalErrorInterceptor";
import ModuleUsageRouteTracker from "./components/ModuleUsageRouteTracker";

// Lazy load tools pages with retry wrapper to handle stale chunks
const ToolsHub = lazyWithRetry(() => import("./pages/tools/ToolsHub"));
const Dashboard = lazyWithRetry(() => import("./pages/tools/Dashboard"));
const RoiCalculator = lazyWithRetry(() => import("./pages/tools/RoiCalculator"));
const FbaFeeCalculator = lazyWithRetry(() => import("./pages/tools/FbaFeeCalculator"));
const BreakEvenCalculator = lazyWithRetry(() => import("./pages/tools/BreakEvenCalculator"));
const BsrSalesEstimator = lazyWithRetry(() => import("./pages/tools/BsrSalesEstimator"));
const WorldwideTracking = lazyWithRetry(() => import("./pages/tools/WorldwideTracking"));
const AsinLookup = lazyWithRetry(() => import("./pages/tools/AsinLookup"));
const UpcToAsin = lazyWithRetry(() => import("./pages/tools/UpcToAsin"));
const AmazonConnect = lazyWithRetry(() => import("./pages/tools/AmazonConnect"));
const ExtHandoff = lazyWithRetry(() => import("./pages/tools/ExtHandoff"));
const LabelPrinting = lazyWithRetry(() => import("./pages/tools/LabelPrinting"));
const FbaEligibilityIssues = lazyWithRetry(() => import("./pages/tools/FbaEligibilityIssues"));
const PrintingWithoutPDF = lazyWithRetry(() => import("./pages/tools/PrintingWithoutPDF"));
const CreateListing = lazyWithRetry(() => import("./pages/tools/CreateListing"));
const Inventory = lazyWithRetry(() => import("./pages/tools/Inventory"));
const SyncedInventory = lazyWithRetry(() => import("./pages/tools/SyncedInventory"));
const InventoryReview = lazyWithRetry(() => import("./pages/tools/InventoryReview"));
const InventoryRestoration = lazyWithRetry(() => import("./pages/tools/InventoryRestoration"));
const CreatedListings = lazyWithRetry(() => import("./pages/tools/CreatedListings"));
const StillThinking = lazyWithRetry(() => import("./pages/tools/StillThinking"));
const Suppliers = lazyWithRetry(() => import("./pages/tools/Suppliers"));
const ApiUsage = lazyWithRetry(() => import("./pages/tools/ApiUsage"));
const Sales = lazyWithRetry(() => import("./pages/tools/Sales"));
const ReportsAccounting = lazyWithRetry(() => import("./pages/tools/ReportsAccounting"));
const Settlement = lazyWithRetry(() => import("./pages/tools/Settlement"));
const ProfitLoss = lazyWithRetry(() => import("./pages/tools/ProfitLoss"));
const Reimbursements = lazyWithRetry(() => import("./pages/tools/Reimbursements"));
const Expenses = lazyWithRetry(() => import("./pages/tools/Expenses"));
const DispositionManagement = lazyWithRetry(() => import("./pages/tools/DispositionManagement"));
const InventoryWriteoff = lazyWithRetry(() => import("./pages/tools/InventoryWriteoff"));

const ShipmentBuilder = lazyWithRetry(() => import("./pages/tools/ShipmentBuilder"));
const PurchaseVsShipmentReport = lazyWithRetry(() => import("./pages/tools/PurchaseVsShipmentReport"));
const UnshippedPurchases = lazyWithRetry(() => import("./pages/tools/UnshippedPurchases"));
const ShipmentTracking = lazyWithRetry(() => import("./pages/tools/ShipmentTracking"));
const ShipmentAccounting = lazyWithRetry(() => import("./pages/tools/ShipmentAccounting"));
const Repricer = lazyWithRetry(() => import("./pages/tools/Repricer"));
const RepricerMonitor = lazyWithRetry(() => import("./pages/tools/RepricerMonitor"));
const RepricerActivityLog = lazyWithRetry(() => import("./pages/tools/RepricerActivityLog"));
const RepricerAutomationStatus = lazyWithRetry(() => import("./pages/tools/RepricerAutomationStatus"));
const RepricerChangeHistory = lazyWithRetry(() => import("./pages/tools/RepricerChangeHistory"));
const RepricerRuleBehavior = lazyWithRetry(() => import("./pages/tools/RepricerRuleBehavior"));
const RepricerRulePerformance = lazyWithRetry(() => import("./pages/tools/RepricerRulePerformance"));
const RepricerCheckedAsins = lazyWithRetry(() => import("./pages/tools/RepricerCheckedAsins"));
const RepricerSimulation = lazyWithRetry(() => import("./pages/tools/RepricerSimulation"));
const RepricerAccountControl = lazyWithRetry(() => import("./pages/tools/RepricerAccountControl"));
const RepricerWorkers = lazyWithRetry(() => import("./pages/tools/RepricerWorkers"));
const DevEnvironmentSetup = lazyWithRetry(() => import("./pages/tools/DevEnvironmentSetup"));
const RepricerSmartEngine = lazyWithRetry(() => import("./pages/tools/RepricerSmartEngine"));
const OperatorQueue = lazyWithRetry(() => import("./pages/tools/OperatorQueue"));
const CommercialTimeline = lazyWithRetry(() => import("./pages/tools/CommercialTimeline"));
const ExecutiveDashboard = lazyWithRetry(() => import("./pages/tools/ExecutiveDashboard"));
const RepricerAnalytics = lazyWithRetry(() => import("./pages/tools/RepricerAnalytics"));
const FetchListingPrice = lazyWithRetry(() => import("./pages/tools/FetchListingPrice"));
const TargetRoiPrice = lazyWithRetry(() => import("./pages/tools/TargetRoiPrice"));
const ReplenishSearch = lazyWithRetry(() => import("./pages/tools/ReplenishSearch"));
const PriceHistory = lazyWithRetry(() => import("./pages/tools/PriceHistory"));
const ProductAnalyzer = lazyWithRetry(() => import("./pages/tools/ProductAnalyzer"));
const SellerAnalyzer = lazyWithRetry(() => import("./pages/tools/SellerAnalyzer"));
const GoogleProductSearch = lazyWithRetry(() => import("./pages/tools/GoogleProductSearch"));
const KeepaProductFinder = lazyWithRetry(() => import("./pages/tools/KeepaProductFinder"));
const MyDatabaseProducts = lazyWithRetry(() => import("./pages/tools/MyDatabaseProducts"));
const PriceExtractor = lazyWithRetry(() => import("./pages/tools/PriceExtractor"));
const SupplierDiscovery = lazyWithRetry(() => import("./pages/tools/SupplierDiscovery"));
const SupplierDiscoveryRunDetails = lazyWithRetry(() => import("./pages/tools/supplier-discovery/RunDetailsPage"));
const UserStoreScan = lazyWithRetry(() => import("./pages/tools/UserStoreScan"));
const UserSupplierDiscovery = lazyWithRetry(() => import("./pages/tools/UserSupplierDiscovery"));
const ScanCategories = lazyWithRetry(() => import("./pages/tools/ScanCategories"));
const Sourcer = lazyWithRetry(() => import("./pages/tools/Sourcer"));

const AutomationSearch = lazyWithRetry(() => import("./pages/leads/AutomationSearch"));
const AdminUpload = lazyWithRetry(() => import("./pages/leads/AdminUpload"));
const AdminAsinUpload = lazyWithRetry(() => import("./pages/leads/AdminAsinUpload"));
const ProductSearch = lazyWithRetry(() => import("./pages/leads/ProductSearch"));
const NeedBuyAgain = lazyWithRetry(() => import("./pages/tools/NeedBuyAgain"));
const ResearchLeads = lazyWithRetry(() => import("./pages/tools/ResearchLeads"));
const AdminManagement = lazyWithRetry(() => import("./pages/tools/AdminManagement"));
const AdminUsers = lazyWithRetry(() => import("./pages/tools/AdminUsers"));
const PendingApprovals = lazyWithRetry(() => import("./pages/tools/PendingApprovals"));

const DatabaseMaintenance = lazyWithRetry(() => import("./pages/tools/DatabaseMaintenance"));
const FecBackfill = lazyWithRetry(() => import("./pages/tools/FecBackfill"));
const PriceDiscrepancyAudit = lazyWithRetry(() => import("./pages/tools/PriceDiscrepancyAudit"));
const CronDiagnostics = lazyWithRetry(() => import("./pages/tools/CronDiagnostics"));
const RepricerEligibilityDiagnostics = lazyWithRetry(() => import("./pages/tools/RepricerEligibilityDiagnostics"));
const AmazonConnection = lazyWithRetry(() => import("./pages/tools/AmazonConnection"));
const ErrorLog = lazyWithRetry(() => import("./pages/tools/ErrorLog"));
const AiActionInsights = lazyWithRetry(() => import("./pages/tools/AiActionInsights"));
const LiveSales = lazyWithRetry(() => import("./pages/tools/LiveSales"));
const MobileLiveSales = lazyWithRetry(() => import("./pages/tools/MobileLiveSales"));
const MobileScan = lazyWithRetry(() => import("./pages/tools/MobileScan"));
const MobileScanDetail = lazyWithRetry(() => import("./pages/tools/MobileScanDetail"));
const MobileScanHistory = lazyWithRetry(() => import("./pages/tools/MobileScanHistory"));
const ScanHistory = lazyWithRetry(() => import("./pages/tools/ScanHistory"));
const MobileInventoryValuation = lazyWithRetry(() => import("./pages/tools/MobileInventoryValuation"));
const EmailCenter = lazyWithRetry(() => import("./pages/tools/EmailCenter"));


const queryClient = new QueryClient();

const LoadingFallback = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
  </div>
);

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HelmetProvider>
        <LanguageProvider>
          <AuthProvider>
            <UiModeProvider>
            <SalesSyncProvider>
            <TooltipProvider>
              <Router>
                <ModuleUsageRouteTracker />
                <LazyErrorBoundary>
                <Suspense fallback={<LoadingFallback />}>
                  <Routes>
                  <Route path="/" element={<Index />} />
                  <Route path="/blog/ai-repricer-behind-the-scenes" element={<BlogAiRepricer />} />
                  <Route path="/blog/real-ai-decisions-live-asins" element={<BlogRealAiDecisions />} />
                  <Route path="/blog/what-ai-repricer-looks-at" element={<BlogAiRepricerLooksAt />} />
                  <Route path="/blog/product-library-amazon-sellers" element={<BlogProductLibrary />} />
                  <Route path="/blog/repricer-features" element={<BlogRepricerFeatures />} />
                  <Route path="/blog/what-repricer-does" element={<BlogWhatRepricerDoes />} />
                  <Route path="/blog/two-sellers-one-asin" element={<BlogTwoSellersOneAsin />} />
                  <Route path="/blog/arbitrage-vs-wholesale-repricing" element={<BlogArbitrageVsWholesaleRepricing />} />

                  <Route path="/contact" element={<Contact />} />
                  <Route path="/support" element={<Support />} />
                  <Route path="/about" element={<About />} />
                  <Route path="/privacy" element={<PrivacyPolicy />} />
                  <Route path="/terms" element={<TermsOfService />} />
                  <Route path="/buy-license" element={<BuyLicense />} />
                  <Route path="/products/ai-repricer" element={<AiRepricerProduct />} />
                  <Route path="/products/product-library" element={<ProductLibraryProduct />} />
                  <Route path="/products/modules/:slug" element={<ModuleExplainer />} />
                  <Route path="/pricing" element={<Pricing />} />
                  
                  <Route path="/signup" element={<SignUp />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/forgot-password" element={<ForgotPassword />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="/diagnostics" element={<Diagnostics />} />
                  <Route path="/auth/callback" element={<AuthCallback />} />
                  <Route path="/auth/signed-in" element={<SignedIn />} />
                  <Route path="/account/complete-profile" element={<CompleteProfile />} />
                  <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
                  
                  <Route path="/tools" element={<ProtectedRoute><ToolsHub /></ProtectedRoute>} />
                  <Route path="/tools/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                  <Route path="/tools/roi" element={<ProtectedRoute><RoiCalculator /></ProtectedRoute>} />
                  <Route path="/tools/target-roi-price" element={<ProtectedRoute><TargetRoiPrice /></ProtectedRoute>} />
                  <Route path="/tools/fba-fee" element={<ProtectedRoute><FbaFeeCalculator /></ProtectedRoute>} />
                  <Route path="/tools/break-even" element={<ProtectedRoute><BreakEvenCalculator /></ProtectedRoute>} />
                  <Route path="/tools/bsr-sales" element={<ProtectedRoute><BsrSalesEstimator /></ProtectedRoute>} />
                  <Route path="/tools/tracking" element={<ProtectedRoute><WorldwideTracking /></ProtectedRoute>} />
                  <Route path="/tools/label-printing" element={<ProtectedRoute><LabelPrinting /></ProtectedRoute>} />
                  <Route path="/tools/fba-eligibility-issues" element={<ProtectedRoute><FbaEligibilityIssues /></ProtectedRoute>} />
                  <Route path="/tools/printing-without-pdf" element={<ProtectedRoute><PrintingWithoutPDF /></ProtectedRoute>} />
                  <Route path="/tools/create-listing" element={<ProtectedRoute><CreateListing /></ProtectedRoute>} />
                  <Route path="/tools/inventory" element={<ProtectedRoute><Inventory /></ProtectedRoute>} />
                  <Route path="/tools/synced-inventory" element={<ProtectedRoute><SyncedInventory /></ProtectedRoute>} />
                  <Route path="/tools/inventory-review" element={<ProtectedRoute><InventoryReview /></ProtectedRoute>} />
                  <Route path="/tools/inventory-restoration" element={<ProtectedRoute><InventoryRestoration /></ProtectedRoute>} />
                  <Route path="/tools/created-listings" element={<ProtectedRoute><CreatedListings /></ProtectedRoute>} />
                  <Route path="/tools/still-thinking" element={<ProtectedRoute><ModuleGuard module="still_thinking" redirectTo="/tools" redirectToast="Access restricted: Still Thinking."><StillThinking /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/suppliers" element={<ProtectedRoute><Suppliers /></ProtectedRoute>} />
                  <Route path="/tools/api-usage" element={<ProtectedRoute><ApiUsage /></ProtectedRoute>} />
                  <Route path="/tools/sales" element={<ProtectedRoute><Sales /></ProtectedRoute>} />
                  <Route path="/tools/reports" element={<ProtectedRoute><ReportsAccounting /></ProtectedRoute>} />
                  <Route path="/tools/profit-loss" element={<ProtectedRoute><ModuleGuard module="profit_loss" redirectTo="/tools" redirectToast="Access restricted: Profit & Loss."><ProfitLoss /></ModuleGuard></ProtectedRoute>} />
                  
                  <Route path="/tools/settlement" element={<ProtectedRoute><Settlement /></ProtectedRoute>} />
                  <Route path="/tools/reimbursements" element={<ProtectedRoute><Reimbursements /></ProtectedRoute>} />
                  <Route path="/tools/expenses" element={<ProtectedRoute><Expenses /></ProtectedRoute>} />
                  <Route path="/tools/disposition-management" element={<ProtectedRoute><DispositionManagement /></ProtectedRoute>} />
                  <Route path="/tools/inventory-writeoff" element={<ProtectedRoute><InventoryWriteoff /></ProtectedRoute>} />
                  <Route path="/tools/need-buy-again" element={<ProtectedRoute><ModuleGuard module="buy_again" redirectTo="/tools" redirectToast="Access restricted: Need to Buy Again."><NeedBuyAgain /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/research-leads" element={<ProtectedRoute><ResearchLeads /></ProtectedRoute>} />
                  <Route path="/tools/shipment-builder" element={<ProtectedRoute><ModuleGuard module="fba_builder" redirectTo="/tools" redirectToast="Access restricted: FBA Shipment Builder."><ShipmentBuilder /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/purchase-vs-shipment" element={<ProtectedRoute><PurchaseVsShipmentReport /></ProtectedRoute>} />
                  <Route path="/tools/unshipped-purchases" element={<ProtectedRoute><UnshippedPurchases /></ProtectedRoute>} />
                  <Route path="/tools/shipment-tracking" element={<ProtectedRoute><ShipmentTracking /></ProtectedRoute>} />
                  <Route path="/tools/shipment-accounting" element={<ProtectedRoute><ShipmentAccounting /></ProtectedRoute>} />
                  <Route path="/tools/repricer" element={<ProtectedRoute><Repricer /></ProtectedRoute>} />
                  <Route path="/tools/repricer/monitor" element={<ProtectedRoute><RepricerMonitor /></ProtectedRoute>} />
                  <Route path="/tools/repricer/activity-log" element={<ProtectedRoute><RepricerActivityLog /></ProtectedRoute>} />
                  <Route path="/tools/repricer/automation-status" element={<ProtectedRoute><RepricerAutomationStatus /></ProtectedRoute>} />
                  <Route path="/tools/repricer/change-history" element={<ProtectedRoute><RepricerChangeHistory /></ProtectedRoute>} />
                  <Route path="/tools/repricer/rule-behavior" element={<ProtectedRoute><RepricerRuleBehavior /></ProtectedRoute>} />
                  <Route path="/tools/repricer/rule-performance" element={<ProtectedRoute><RepricerRulePerformance /></ProtectedRoute>} />
                  <Route path="/tools/repricer/checked-asins" element={<ProtectedRoute><RepricerCheckedAsins /></ProtectedRoute>} />
                  <Route path="/tools/repricer/simulation" element={<ProtectedRoute><RepricerSimulation /></ProtectedRoute>} />
                  <Route path="/tools/repricer/account-control" element={<ProtectedRoute><RepricerAccountControl /></ProtectedRoute>} />
                  <Route path="/tools/repricer/workers" element={<ProtectedRoute><RepricerWorkers /></ProtectedRoute>} />
                  <Route path="/tools/dev-environment-setup" element={<ProtectedRoute><DevEnvironmentSetup /></ProtectedRoute>} />
                  <Route path="/tools/repricer/smart-engine" element={<ProtectedRoute><RepricerSmartEngine /></ProtectedRoute>} />
                  <Route path="/tools/repricer/operator-queue" element={<ProtectedRoute><OperatorQueue /></ProtectedRoute>} />
                  <Route path="/tools/repricer/timeline/:asin" element={<ProtectedRoute><CommercialTimeline /></ProtectedRoute>} />
                  <Route path="/tools/executive" element={<ProtectedRoute><ExecutiveDashboard /></ProtectedRoute>} />
                  <Route path="/tools/repricer/analytics" element={<ProtectedRoute><RepricerAnalytics /></ProtectedRoute>} />
                  <Route path="/tools/repricer/live-sales" element={<ProtectedRoute><LiveSales /></ProtectedRoute>} />
                  <Route path="/m/live-sales" element={<ProtectedRoute><ModuleGuard module="mobile_live_sales" redirectTo="/tools" redirectToast="Access restricted: Mobile Live Sales."><MobileLiveSales /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/m/scan" element={<ProtectedRoute><MobileScan /></ProtectedRoute>} />
                  <Route path="/m/scan/:id" element={<ProtectedRoute><MobileScanDetail /></ProtectedRoute>} />
                  <Route path="/m/history" element={<ProtectedRoute><ModuleGuard module="scan_history" redirectTo="/tools" redirectToast="Access restricted: Scan History."><MobileScanHistory /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/scan-history" element={<ProtectedRoute><ModuleGuard module="scan_history" redirectTo="/tools" redirectToast="Access restricted: Scan History."><ScanHistory /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/m/inventory-valuation" element={<ProtectedRoute><ModuleGuard module="mobile_inventory_valuation" redirectTo="/tools" redirectToast="Access restricted: Mobile Inventory Valuation."><MobileInventoryValuation /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/fetch-listing-price" element={<ProtectedRoute><FetchListingPrice /></ProtectedRoute>} />
                  <Route path="/tools/replenish-search" element={<ProtectedRoute><ReplenishSearch /></ProtectedRoute>} />
                  <Route path="/tools/asin-lookup" element={<ProtectedRoute><AsinLookup /></ProtectedRoute>} />
                  <Route path="/tools/upc-to-asin" element={<ProtectedRoute><ModuleGuard module="upc_scanner" redirectTo="/tools" redirectToast="Access restricted: UPC Scanner."><UpcToAsin /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/tools/amazon-connect" element={<ProtectedRoute><AmazonConnect /></ProtectedRoute>} />
                  <Route path="/tools/ext-handoff" element={<ProtectedRoute><ExtHandoff /></ProtectedRoute>} />
                  <Route path="/tools/email-center" element={<ProtectedRoute><EmailCenter /></ProtectedRoute>} />
                  <Route path="/tools/price-history" element={<ProtectedRoute><PriceHistory /></ProtectedRoute>} />
                  <Route path="/tools/product-analyzer" element={<ProtectedRoute><ProductAnalyzer /></ProtectedRoute>} />
                  <Route path="/tools/seller-analyzer" element={<ProtectedRoute><SellerAnalyzer /></ProtectedRoute>} />
                  <Route path="/tools/google-product-search" element={<ProtectedRoute><GoogleProductSearch /></ProtectedRoute>} />
                  <Route path="/tools/product-finder" element={<ProtectedRoute><KeepaProductFinder /></ProtectedRoute>} />
                  <Route path="/tools/my-database-products" element={<ProtectedRoute><MyDatabaseProducts /></ProtectedRoute>} />
                  <Route path="/tools/price-extractor" element={<ProtectedRoute><PriceExtractor /></ProtectedRoute>} />
                  <Route path="/tools/supplier-discovery" element={<ProtectedRoute><SupplierDiscovery /></ProtectedRoute>} />
                  <Route path="/tools/supplier-discovery/runs/:runId" element={<ProtectedRoute><SupplierDiscoveryRunDetails /></ProtectedRoute>} />
                  <Route path="/tools/user-store-scan" element={<ProtectedRoute><UserStoreScan /></ProtectedRoute>} />
                  <Route path="/tools/user-supplier-discovery" element={<ProtectedRoute><UserSupplierDiscovery /></ProtectedRoute>} />
                  <Route path="/tools/scan-categories" element={<ProtectedRoute><ScanCategories /></ProtectedRoute>} />
                  <Route path="/tools/sourcer" element={<ProtectedRoute><Sourcer /></ProtectedRoute>} />
                  
                  <Route path="/amazon/connect" element={<ProtectedRoute><AmazonConnect /></ProtectedRoute>} />
                  
                  <Route path="/leads/automation" element={<ProtectedRoute><AutomationSearch /></ProtectedRoute>} />
                  <Route path="/leads/product-search" element={<ProtectedRoute><ProductSearch /></ProtectedRoute>} />
                  <Route path="/leads/admin-upload" element={<ProtectedRoute><AdminUpload /></ProtectedRoute>} />
                  <Route path="/leads/admin-asin-upload" element={<ProtectedRoute><AdminAsinUpload /></ProtectedRoute>} />
                  
                  <Route path="/PersonalHour" element={<ProtectedRoute><ModuleGuard module="personalhour" redirectTo="/tools" redirectToast="Access restricted: PersonalHour is owner-only."><PersonalHour /></ModuleGuard></ProtectedRoute>} />
                  <Route path="/admin" element={<AdminDownload />} />
                  <Route path="/subscriptions" element={<ProtectedRoute><Subscriptions /></ProtectedRoute>} />
                  <Route path="/tools/admin-management" element={<ProtectedRoute><AdminManagement /></ProtectedRoute>} />
                  <Route path="/tools/admin-users" element={<ProtectedRoute><AdminUsers /></ProtectedRoute>} />
                  <Route path="/tools/pending-approvals" element={<ProtectedRoute><PendingApprovals /></ProtectedRoute>} />

                  <Route path="/tools/database-maintenance" element={<ProtectedRoute><DatabaseMaintenance /></ProtectedRoute>} />
                  <Route path="/tools/fec-backfill" element={<ProtectedRoute><FecBackfill /></ProtectedRoute>} />
                  <Route path="/tools/price-discrepancy-audit" element={<ProtectedRoute><PriceDiscrepancyAudit /></ProtectedRoute>} />
                  <Route path="/tools/cron-diagnostics" element={<ProtectedRoute><CronDiagnostics /></ProtectedRoute>} />
                  <Route path="/tools/repricer-eligibility-diagnostics" element={<ProtectedRoute><RepricerEligibilityDiagnostics /></ProtectedRoute>} />
                  <Route path="/tools/amazon-connection" element={<ProtectedRoute><AmazonConnection /></ProtectedRoute>} />
                  <Route path="/tools/error-log" element={<ProtectedRoute><ErrorLog /></ProtectedRoute>} />
                  <Route path="/tools/ai-insights" element={<ProtectedRoute><AiActionInsights /></ProtectedRoute>} />
                  
                  
                  <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
                </LazyErrorBoundary>
                {/* Reloads this tab when a newer build ships. Never forces a
                    reload over in-progress edits -- see AppVersionGate. */}
                <AppVersionGate />
                <Toaster />
                <SonnerToaster position="top-right" richColors closeButton />
                <DesktopOnlyWidgets />
                <GlobalErrorInterceptor />
              </Router>
            </TooltipProvider>
            </SalesSyncProvider>
            </UiModeProvider>
          </AuthProvider>
        </LanguageProvider>
      </HelmetProvider>
    </QueryClientProvider>
  );
}

export default App;