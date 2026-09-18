import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NavbarLinksProps } from "./NavbarLinks";
import { useLanguage } from "@/contexts/LanguageContext";
import { ShoppingCart, LogOut, User, Lock, RefreshCw, Check, AlertCircle, BookOpen, ChevronDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import RequireAuthLink from "@/components/RequireAuthLink";
import { TOOLS } from "@/config/tools";
import { supabase } from "@/integrations/supabase/client";
import { useSalesSync } from "@/contexts/SalesSyncContext";

const BLOG_ITEMS = [
  { to: "/blog/repricer-features", title: "Every Feature Inside Our AI Repricer" },
  { to: "/blog/ai-repricer-behind-the-scenes", title: "AI Repricer Behind the Scenes" },
  { to: "/blog/real-ai-decisions-live-asins", title: "Real AI Decisions from Live ASINs" },
  { to: "/blog/what-ai-repricer-looks-at", title: "What an AI Repricer Looks At" },
  { to: "/blog/product-library-amazon-sellers", title: "Product Library for Amazon Sellers" },
  { to: "/blog/what-repricer-does", title: "What a Repricer Actually Does" },
  { to: "/blog/two-sellers-one-asin", title: "Two Sellers, One ASIN" },
  { to: "/blog/arbitrage-vs-wholesale-repricing", title: "Arbitrage vs Wholesale Repricing" },
];

const BlogMobileSection: React.FC<{ navigate: (path: string) => void }> = ({ navigate }) => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <a
        onClick={() => setOpen(!open)}
        className="py-2 px-4 text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer flex items-center justify-between"
      >
        <span className="flex items-center gap-2"><BookOpen className="h-4 w-4" /> Blog</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </a>
      {open && (
        <div className="ml-4 space-y-1 border-l-2 border-brand-200 pl-4">
          {BLOG_ITEMS.map((blog) => (
            <a
              key={blog.to}
              onClick={() => navigate(blog.to)}
              className="block py-1 px-2 text-sm text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
            >
              {blog.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

type NavbarMobileMenuProps = NavbarLinksProps;

const NavbarMobileMenu: React.FC<NavbarMobileMenuProps> = ({
  goToHome,
  handleNavigation,
}) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const { syncState, startBackgroundSync, isSyncing: isGlobalSyncing, isRecentlySynced } = useSalesSync();

  useEffect(() => {
    const checkAdmin = async () => {
      if (!user) {
        console.log("NavbarMobile: No user, setting isAdmin to false");
        setIsAdmin(false);
        return;
      }
      
      console.log("NavbarMobile: Checking admin status for user:", user.id);
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .maybeSingle(); // Use maybeSingle() instead of single() to handle no results gracefully
      
      if (error) {
        console.error("NavbarMobile: Error checking admin status:", error);
        setIsAdmin(false);
        return;
      }
      
      const hasAdminRole = !!data;
      console.log("NavbarMobile: Admin status result:", hasAdminRole, data);
      setIsAdmin(hasAdminRole);
    };
    checkAdmin();
  }, [user]);
  
  const handleAboutClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'about_us_mobile_nav',
        value: 1
      });
    }
    navigate('/about');
  };

  const handleContactClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'contact_mobile_nav',
        value: 1
      });
    }
    navigate('/contact');
  };

  const handleSignOut = async () => {
    await signOut();
    toast({
      title: "Logged out",
      description: "You've been successfully logged out",
    });
    navigate('/');
  };

  return (
    <div className="md:hidden bg-white/95 backdrop-blur-md border-t border-gray-200">
      <div className="container mx-auto py-4 px-4">
        <div className="flex flex-col space-y-2">
          <a
            onClick={goToHome}
            className="py-2 px-4 text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
          >
            {t('nav.home')}
          </a>

          <div className="ml-4 space-y-1 border-l-2 border-brand-200 pl-4">
            <p className="text-sm font-medium text-brand-800 px-2 py-1">Products</p>
            <a
              onClick={() => navigate('/products/ai-repricer')}
              className="block py-1 px-2 text-sm text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
            >
              ⚡ AI Repricer <span className="text-[10px] uppercase font-bold text-primary ml-1">Free Trial</span>
            </a>
            <a
              onClick={() => navigate('/products/product-library')}
              className="block py-1 px-2 text-sm text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
            >
              📚 Product Library
            </a>
          </div>
          
          <div className="ml-4 space-y-1 border-l-2 border-brand-200 pl-4">
            <p className="text-sm font-medium text-brand-800 px-2 py-1 flex items-center gap-2">
              Tools
              {!user && <Lock className="h-3 w-3" />}
            </p>
            {TOOLS.filter(tool => !tool.adminOnly || isAdmin).map((tool) => (
              <RequireAuthLink
                key={tool.path}
                to={tool.path}
                className={`block py-1 px-2 text-sm hover:bg-brand-50 rounded transition-colors cursor-pointer ${tool.adminOnly ? 'text-red-600 hover:text-red-700' : 'text-brand-600 hover:text-brand-700'}`}
                onClick={() => {
                  if (window.gtag) {
                    window.gtag('event', 'tool_used', { 
                      tool_name: tool.ga || tool.label, 
                      source: 'mobile_navbar' 
                    });
                  }
                }}
              >
                {tool.adminOnly && '👑 '}{tool.label}
              </RequireAuthLink>
            ))}
            {isAdmin && (
              <>
                <RequireAuthLink
                  to="/leads/automation"
                  className="block py-1 px-2 text-sm text-red-600 hover:text-red-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
                  onClick={() => {
                    if (window.gtag) {
                      window.gtag('event', 'tool_used', { 
                        tool_name: 'automation_search', 
                        source: 'mobile_navbar' 
                      });
                    }
                  }}
                >
                  👑 Automation Search
                </RequireAuthLink>
                <RequireAuthLink
                  to="/leads/product-search"
                  className="block py-1 px-2 text-sm text-red-600 hover:text-red-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
                  onClick={() => {
                    if (window.gtag) {
                      window.gtag('event', 'tool_used', { 
                        tool_name: 'product_search', 
                        source: 'mobile_navbar' 
                      });
                    }
                  }}
                >
                  👑 Search Products
                </RequireAuthLink>
                <RequireAuthLink
                  to="/tools"
                  className="block py-1 px-2 text-sm text-red-600 hover:text-red-700 hover:bg-brand-50 rounded transition-colors cursor-pointer font-semibold"
                  onClick={() => {
                    if (window.gtag) {
                      window.gtag('event', 'tool_used', { 
                        tool_name: 'tool_menu_hub', 
                        source: 'mobile_navbar' 
                      });
                    }
                  }}
                >
                  👑 View all tools →
                </RequireAuthLink>
              </>
            )}
          </div>
          
          {/* Blog menu hidden for now (2026-07-26 request) -- BlogMobileSection
              is still defined above, just not rendered. */}

          <a
            onClick={handleAboutClick}
            className="py-2 px-4 text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
          >
            {t('nav.about_us')}
          </a>
          <a
            onClick={handleContactClick}
            className="py-2 px-4 text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors cursor-pointer"
          >
            {t('nav.contact')}
          </a>
          

          {/* Auth UI for Mobile */}
          {user ? (
            <>
              <div className="py-2 px-4 border-t border-gray-200 mt-2 pt-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                  <User size={16} />
                  <span className="truncate">{user.email}</span>
                </div>
                
                {/* Sales Sync Button for Mobile */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mb-2"
                  onClick={() => startBackgroundSync({ force: true })}
                  disabled={isGlobalSyncing}
                >
                  {isGlobalSyncing ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Syncing Sales…
                    </>
                  ) : syncState.status === 'error' ? (
                    <>
                      <AlertCircle className="mr-2 h-4 w-4 text-destructive" />
                      Sync Failed - Retry
                    </>
                  ) : syncState.status === 'success' && isRecentlySynced ? (
                    <>
                      <Check className="mr-2 h-4 w-4 text-green-500" />
                      Sales Synced
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Sync Sales
                    </>
                  )}
                </Button>
                
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full"
                  onClick={handleSignOut}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Log out
                </Button>
              </div>
            </>
          ) : (
            <div className="flex gap-2 mt-2 pt-4 border-t border-gray-200">
              <Button 
                variant="outline" 
                size="sm"
                className="flex-1"
                onClick={() => navigate('/login')}
              >
                Log in
              </Button>
              <Button 
                size="sm"
                className="flex-1"
                onClick={() => navigate('/signup')}
              >
                Sign up
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NavbarMobileMenu;
