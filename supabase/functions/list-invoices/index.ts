import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[LIST-INVOICES] ${step}${d}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Check if user is admin
    const { data: adminRole } = await supabaseClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    const isAdmin = !!adminRole;
    logStep("Admin check", { isAdmin });

    const allInvoices: Array<{
      id: string;
      number: string | null;
      status: string | null;
      amount_due: number;
      amount_paid: number;
      currency: string;
      created: number;
      due_date: number | null;
      hosted_invoice_url: string | null;
      invoice_pdf: string | null;
      product_name: string | null;
      subscription_id: string | null;
      source: string;
    }> = [];

    // 1. Fetch Stripe invoices
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length > 0) {
      const customerId = customers.data[0].id;
      logStep("Found Stripe customer", { customerId });

      const invoices = await stripe.invoices.list({
        customer: customerId,
        limit: 100,
      });

      for (const inv of invoices.data) {
        allInvoices.push({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amount_due: inv.amount_due,
          amount_paid: inv.amount_paid,
          currency: inv.currency,
          created: inv.created,
          due_date: inv.due_date,
          hosted_invoice_url: inv.hosted_invoice_url,
          invoice_pdf: inv.invoice_pdf,
          product_name: inv.lines?.data?.[0]?.description ?? null,
          subscription_id: typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
          source: "stripe",
        });
      }
      logStep("Fetched Stripe invoices", { count: invoices.data.length });
    }

    // 2. Fetch generated invoices (admin $0 invoices)
    if (isAdmin) {
      // First, auto-generate current month's invoice if missing
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodStartStr = periodStart.toISOString().split("T")[0];

      const { data: existingCurrent } = await supabaseClient
        .from("generated_invoices")
        .select("id")
        .eq("user_id", user.id)
        .eq("period_start", periodStartStr)
        .maybeSingle();

      if (!existingCurrent) {
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const { data: seqData } = await supabaseClient.rpc("nextval_generated_invoice_seq");
        const seqNum = seqData ?? Date.now();
        // Prefix is INV-, not a brand initialism. APS- was ArbiProSeller, and
        // baking a brand into an invoice number is what forced a scrub once
        // already. The digits come from the nextval_generated_invoice_seq
        // sequence, so they stay monotonic and continuous across this change --
        // only the prefix differs, and issued APS- invoices are left alone.
        const invoiceNumber = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${String(seqNum).padStart(4, "0")}`;

        await supabaseClient.from("generated_invoices").insert({
          user_id: user.id,
          invoice_number: invoiceNumber,
          period_start: periodStartStr,
          period_end: periodEnd.toISOString().split("T")[0],
          product_name: "InventorySprint",
          amount: 0,
          currency: "USD",
          status: "paid",
          issued_at: now.toISOString(),
          due_date: periodStartStr,
        });
        logStep("Auto-generated current month invoice", { invoiceNumber });
      }

      // Fetch all generated invoices
      const { data: genInvoices } = await supabaseClient
        .from("generated_invoices")
        .select("*")
        .eq("user_id", user.id)
        .order("period_start", { ascending: false });

      if (genInvoices) {
        for (const gi of genInvoices) {
          const issuedTs = Math.floor(new Date(gi.issued_at).getTime() / 1000);
          const dueTs = gi.due_date ? Math.floor(new Date(gi.due_date).getTime() / 1000) : null;

          allInvoices.push({
            id: gi.id,
            number: gi.invoice_number,
            status: gi.status,
            amount_due: 0,
            amount_paid: 0,
            currency: gi.currency,
            created: issuedTs,
            due_date: dueTs,
            hosted_invoice_url: null,
            invoice_pdf: null, // Will be generated on-demand via generate-invoice-pdf
            product_name: `${gi.product_name} — ${gi.period_start} to ${gi.period_end}`,
            subscription_id: null,
            source: "generated",
          });
        }
        logStep("Fetched generated invoices", { count: genInvoices.length });
      }
    }

    // Sort all invoices by created date descending
    allInvoices.sort((a, b) => b.created - a.created);

    return new Response(
      JSON.stringify({ invoices: allInvoices }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
