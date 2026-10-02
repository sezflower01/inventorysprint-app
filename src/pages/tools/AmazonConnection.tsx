import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Save, Plug, ShieldCheck, AlertTriangle, CheckCircle2, KeyRound, Trash2 } from "lucide-react";

interface CredentialMeta {
  user_id: string;
  region: string;
  marketplace: string;
  lwa_client_id_last4: string | null;
  refresh_token_last4: string | null;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
  last_test_seller_id: string | null;
  last_test_marketplaces: any | null;
  updated_at: string;
}

const REGIONS = [
  { value: "na", label: "North America (US, CA, MX, BR)" },
  { value: "eu", label: "Europe (UK, DE, FR, IT, ES…)" },
  { value: "fe", label: "Far East (JP, AU, SG, IN…)" },
];

/**
 * Credentials are trimmed before they leave the browser.
 *
 * Copying an LWA secret out of Seller Central very often brings a trailing
 * newline or space with it, and nothing on either side of this call used to
 * remove it: the UI sent the raw field, spapi-credentials stored it verbatim,
 * and Amazon then answered the next token exchange with
 *   "Client authentication failed"
 * -- which reads as "wrong secret" and sends you back to Seller Central to
 * rotate again, when the value was right and only the whitespace was wrong.
 * Hit for real on 2026-10-02, immediately after a routine 180-day rotation.
 *
 * Empty after trimming means "leave what is stored alone", which is what the
 * blank-field convention on this page already promises.
 */
const cleanCred = (v: string) => {
  const t = (v || "").trim();
  return t.length > 0 ? t : null;
};

export default function AmazonConnection() {
  const { user } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<CredentialMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Form state — empty means "leave unchanged" on save.
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [region, setRegion] = useState("na");
  const [marketplace, setMarketplace] = useState("US");

  useEffect(() => {
    if (subLoading) return;
    if (!isAdmin) {
      navigate("/tools");
      return;
    }
    if (user?.id) load(user.id);
  }, [isAdmin, subLoading, user?.id]);

  async function load(uid: string) {
    setLoading(true);
    const { data, error } = await supabase
      .from("user_spapi_credentials")
      .select(
        "user_id, region, marketplace, lwa_client_id_last4, refresh_token_last4, last_test_at, last_test_status, last_test_error, last_test_seller_id, last_test_marketplaces, updated_at"
      )
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      console.warn("[AmazonConnection] load error:", error.message);
    }
    if (data) {
      setMeta(data as any);
      setRegion((data as any).region || "na");
      setMarketplace((data as any).marketplace || "US");
    }
    setLoading(false);
  }

  async function handleSave() {
    if (!user?.id) return;
    if (!clientId && !clientSecret && !refreshToken && meta) {
      // Allow saving region/marketplace only
    }
    setSaving(true);
    const { data, error } = await supabase.functions.invoke("spapi-credentials", {
      body: {
        action: "save",
        user_id: user.id,
        lwa_client_id: cleanCred(clientId),
        lwa_client_secret: cleanCred(clientSecret),
        refresh_token: cleanCred(refreshToken),
        region,
        marketplace,
      },
    });
    setSaving(false);
    if (error || (data as any)?.error) {
      toast.error((data as any)?.error || error?.message || "Save failed");
      return;
    }
    toast.success("Credentials saved (encrypted at rest).");
    setClientId("");
    setClientSecret("");
    setRefreshToken("");
    await load(user.id);
  }

  async function handleTest() {
    if (!user?.id) return;
    setTesting(true);
    const { data, error } = await supabase.functions.invoke("spapi-credentials", {
      body: {
        action: "test",
        user_id: user.id,
        lwa_client_id: cleanCred(clientId),
        lwa_client_secret: cleanCred(clientSecret),
        refresh_token: cleanCred(refreshToken),
        region,
      },
    });
    setTesting(false);
    if (error) {
      toast.error(error.message);
    } else if ((data as any)?.ok) {
      toast.success(`Connected. Seller: ${(data as any).sellerId || "—"}`);
    } else {
      toast.error((data as any)?.error || "Test failed");
    }
    await load(user.id);
  }

  async function handleDelete() {
    if (!user?.id) return;
    if (!confirm("Delete the stored Amazon SP-API credentials for this account? You will need to re-enter Client ID, Secret, and Refresh Token to reconnect.")) return;
    setDeleting(true);
    const { data, error } = await supabase.functions.invoke("spapi-credentials", {
      body: { action: "delete", user_id: user.id },
    });
    setDeleting(false);
    if (error || (data as any)?.error) {
      toast.error((data as any)?.error || error?.message || "Delete failed");
      return;
    }
    toast.success("Stored credentials deleted.");
    setMeta(null);
    setClientId("");
    setClientSecret("");
    setRefreshToken("");
  }

  const hasAnySaved =
    !!meta?.lwa_client_id_last4 || !!meta?.refresh_token_last4;
  const hasFormCreds = !!clientId && !!clientSecret && !!refreshToken;
  const canTest = hasAnySaved || hasFormCreds;
  const testDisabledReason = !canTest
    ? "Save credentials first (or fill in all 3 fields) to enable Test."
    : "";

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Amazon SP-API Connection | InventorySprint</title>
        <meta name="description" content="Manage your Amazon Selling Partner API credentials securely." />
      </Helmet>
      <Navbar />
      <main className="flex-1 container mx-auto px-4 py-8 max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Plug className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Amazon SP-API Connection</h1>
            <p className="text-sm text-muted-foreground">
              Admin-only · credentials are encrypted at rest with pgsodium and never returned in plain text.
            </p>
          </div>
        </div>

        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>How this works</AlertTitle>
          <AlertDescription className="text-sm space-y-1 mt-1">
            <p>• Your Client ID, Client Secret, and Refresh Token are encrypted before being stored.</p>
            <p>• Only edge functions running with the service role can decrypt them.</p>
            <p>• You'll only ever see the last 4 characters in the UI. To change a value, type a new one — leave a field blank to keep what's stored.</p>
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Credentials
            </CardTitle>
            <CardDescription>
              Get these from{" "}
              <a
                href="https://sellercentral.amazon.com/apps/manage"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Seller Central → Develop Apps → Authorize
              </a>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Region</Label>
                    <Select value={region} onValueChange={setRegion}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {REGIONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Default marketplace</Label>
                    <Input value={marketplace} onChange={(e) => setMarketplace(e.target.value.toUpperCase().slice(0, 4))} placeholder="US" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>LWA Client ID</Label>
                  <Input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={meta?.lwa_client_id_last4 ? `••••••••${meta.lwa_client_id_last4}` : "amzn1.application-oa2-client.xxxxxxxx"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>LWA Client Secret</Label>
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={hasAnySaved ? "•••••••• (leave blank to keep current)" : "amzn1.oa2-cs.v1...."}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>SP-API Refresh Token</Label>
                  <Input
                    type="password"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder={meta?.refresh_token_last4 ? `••••••••${meta.refresh_token_last4}` : "Atzr|..."}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleTest}
                    disabled={testing || !canTest}
                    title={testDisabledReason}
                  >
                    {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plug className="h-4 w-4 mr-2" />}
                    Test connection
                  </Button>
                  {hasAnySaved && (
                    <Button
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                      Delete stored credentials
                    </Button>
                  )}
                </div>
                {!canTest && (
                  <p className="text-xs text-muted-foreground">
                    {testDisabledReason}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {meta && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
              <CardDescription>Last test result for this account.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                {meta.last_test_status === "ok" ? (
                  <Badge className="bg-green-600 hover:bg-green-600"><CheckCircle2 className="h-3 w-3 mr-1" /> Connected</Badge>
                ) : meta.last_test_status === "error" ? (
                  <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" /> Error</Badge>
                ) : (
                  <Badge variant="outline">Never tested</Badge>
                )}
                {meta.last_test_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(meta.last_test_at).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Client ID</div>
                  <div className="font-mono">{meta.lwa_client_id_last4 ? `••••${meta.lwa_client_id_last4}` : "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Refresh Token</div>
                  <div className="font-mono">{meta.refresh_token_last4 ? `••••${meta.refresh_token_last4}` : "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Seller ID</div>
                  <div className="font-mono">{meta.last_test_seller_id || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Region / Marketplace</div>
                  <div>{(meta.region || "na").toUpperCase()} · {meta.marketplace}</div>
                </div>
              </div>
              {meta.last_test_error && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Last error</AlertTitle>
                  <AlertDescription className="text-xs break-all">{meta.last_test_error}</AlertDescription>
                </Alert>
              )}
              {Array.isArray(meta.last_test_marketplaces) && meta.last_test_marketplaces.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Authorized marketplaces</div>
                  <div className="flex flex-wrap gap-1">
                    {meta.last_test_marketplaces.map((m: any, i: number) => (
                      <Badge key={i} variant="outline">{m.countryCode || m.id}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>
      <Footer />
    </div>
  );
}
