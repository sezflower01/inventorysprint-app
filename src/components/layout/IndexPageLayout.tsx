
import React, { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

interface IndexPageLayoutProps {
  children: React.ReactNode;
  metaTitle: string;
  metaDescription: string;
}

const IndexPageLayout = ({ children, metaTitle, metaDescription }: IndexPageLayoutProps) => {
  useEffect(() => {
    // Track page view
    if (typeof gtag !== 'undefined') {
      gtag('config', 'GA_MEASUREMENT_ID', {
        page_title: metaTitle,
        page_location: window.location.href
      });
    }
  }, [metaTitle]);

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
        <meta name="keywords" content="amazon repricer software, amazon repricing tool, auto repricer amazon, AI amazon repricer, FBA profit tracker, Amazon FBA software, Amazon seller tools, Amazon sourcing software, FBA sourcing tools, amazon inventory management, inventory tracking software, inventory sprint, amazon inventory, amazon seller software, amazon profit calculator, amazon listing tools" />
        <meta name="author" content="InventorySprint" />
        <link rel="canonical" href="https://inventorysprint.com/" />

        {/* These mirror the fallback tags in index.html, which now carry
            data-rh="true" so react-helmet-async adopts and replaces them
            rather than leaving a second copy on every page. If a tag is
            removed from here it disappears from the homepage entirely -- the
            static copy is a pre-hydration fallback, not a backstop. */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://inventorysprint.com/" />
        <meta property="og:title" content="Amazon Repricer & Inventory | InventorySprint" />
        <meta property="og:description" content="Find profitable products, track suppliers, and automate pricing in one system. Built for Amazon sellers who want to scale faster with real data." />
        <meta property="og:image" content="https://inventorysprint.com/logo-icon.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:site_name" content="InventorySprint" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content="https://inventorysprint.com/" />
        <meta name="twitter:title" content="Amazon Repricer & Inventory | InventorySprint" />
        <meta name="twitter:description" content="Find profitable products, track suppliers, and automate pricing in one system. Built for Amazon sellers who want to scale faster with real data." />
        <meta name="twitter:image" content="https://inventorysprint.com/logo-icon.png" />
        
        {/* Google Analytics 4 */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
        <script>
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'GA_MEASUREMENT_ID', {
              page_title: '${metaTitle}',
              page_location: window.location.href,
              send_page_view: true
            });
          `}
        </script>
        
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "InventorySprint",
            "applicationCategory": "BusinessApplication",
            "operatingSystem": "Windows",
            "description": "Database software for Amazon sellers to track and manage product sourcing decisions",
            "url": "https://inventorysprint.com/",
            "downloadUrl": "https://inventorysprint.com/download",
            "softwareVersion": "2.0",
            "offers": {
              "@type": "Offer",
              "price": "0",
              "priceCurrency": "USD",
              "description": "60-day free autopilot trial"
            },
            "author": {
              "@type": "Organization",
              "name": "InventorySprint"
            },
            "screenshot": "https://inventorysprint.com/uploads/b8ba423b-b572-442e-9aea-856f91ca576d.png"
          }
        `}</script>
      </Helmet>
      
      <Navbar />
      <main className="flex-grow">
        {children}
      </main>
      <Footer />
    </div>
  );
};

export default IndexPageLayout;
