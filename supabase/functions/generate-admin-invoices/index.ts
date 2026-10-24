import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[GENERATE-ADMIN-INVOICES] ${step}${d}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    log("Started");

    // Get all admin users
    const { data: adminRoles, error: rolesErr } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");

    if (rolesErr) throw new Error(`Failed to fetch admin roles: ${rolesErr.message}`);
    if (!adminRoles || adminRoles.length === 0) {
      log("No admin users found");
      return new Response(
        JSON.stringify({ success: true, generated: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    let generated = 0;

    for (const { user_id } of adminRoles) {
      // Check if invoice already exists for this period
      const { data: existing } = await supabase
        .from("generated_invoices")
        .select("id")
        .eq("user_id", user_id)
        .eq("period_start", periodStart.toISOString().split("T")[0])
        .maybeSingle();

      if (existing) {
        log("Invoice already exists", { user_id, period: periodStart.toISOString().split("T")[0] });
        continue;
      }

      // Get next invoice number
      const { data: seqData } = await supabase.rpc("nextval_generated_invoice_seq");
      const seqNum = seqData ?? Date.now();
      // Prefix is INV-, not a brand initialism. APS- was ArbiProSeller, and
      // baking a brand into an invoice number is what forced a scrub once
      // already. The digits come from the nextval_generated_invoice_seq
      // sequence, so they stay monotonic and continuous across this change --
      // only the prefix differs, and issued APS- invoices are left alone.
      const invoiceNumber = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${String(seqNum).padStart(4, "0")}`;

      const { error: insertErr } = await supabase
        .from("generated_invoices")
        .insert({
          user_id,
          invoice_number: invoiceNumber,
          period_start: periodStart.toISOString().split("T")[0],
          period_end: periodEnd.toISOString().split("T")[0],
          product_name: "InventorySprint",
          amount: 0,
          currency: "USD",
          status: "paid",
          issued_at: now.toISOString(),
          due_date: periodStart.toISOString().split("T")[0],
        });

      if (insertErr) {
        log("Failed to create invoice", { user_id, error: insertErr.message });
      } else {
        generated++;
        log("Created invoice", { user_id, invoiceNumber });
      }
    }

    return new Response(
      JSON.stringify({ success: true, generated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    log("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
