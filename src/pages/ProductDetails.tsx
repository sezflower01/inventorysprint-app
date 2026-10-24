import React from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import InsertFormSection from "@/components/InsertFormSection";
import DraftFeatureSection from "@/components/DraftFeatureSection";
import RepurchaseDecision from "@/components/RepurchaseDecision";
import AmazonReplenishment from "@/components/AmazonReplenishment";
import SumButtonFeature from "@/components/SumButtonFeature";
import FlagOrder from "@/components/FlagOrder";
import MarkUnitsReceived from "@/components/MarkUnitsReceived";
import AutomaticSupplierDetection from "@/components/AutomaticSupplierDetection";
import UpdateRecord from "@/components/UpdateRecord";
import DraftHistory from "@/components/DraftHistory";
import { Toaster } from "@/components/ui/toaster";
import { Helmet } from "react-helmet-async";

const ProductDetails = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Product Features - InventorySprint Database Software</title>
        <meta name="description" content="Detailed features of InventorySprint including product research, supplier management, inventory tracking, and more." />
        <link rel="canonical" href="https://inventorysprint.com/product-details" />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-16">
        <div className="container mx-auto px-4 py-20">
          <h1 className="text-4xl font-bold text-center mb-16">
            Detailed <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">Product Features</span>
          </h1>
        </div>
        <InsertFormSection />
        <DraftFeatureSection />
        <RepurchaseDecision />
        <AmazonReplenishment />
        <SumButtonFeature />
        <FlagOrder />
        <MarkUnitsReceived />
        <AutomaticSupplierDetection />
        <UpdateRecord />
        <DraftHistory />
      </main>
      <Footer />
      <Toaster />
    </div>
  );
};

export default ProductDetails;