import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Printer, Download, CheckCircle2, XCircle, Loader2, RefreshCw, Apple, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  loadThermalSettings,
  saveThermalSettings,
  THERMAL_LABEL_SIZES,
  type Dpi,
  type PrinterLanguage,
  type ThermalLabelSizeId,
} from "@/lib/printerSettings";

const PRINT_CLIENT_BUCKET = "access";
const PRINT_CLIENT_PATH = "SprintPrint.exe";
const CLIENT_URLS = ["http://127.0.0.1:7777", "http://localhost:7777"];

type Status = "checking" | "connected" | "disconnected";

const detectOS = (): "windows" | "mac" | "other" => {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (ua.includes("windows") || platform.includes("win")) return "windows";
  if (ua.includes("mac") || platform.includes("mac") || ua.includes("iphone") || ua.includes("ipad")) return "mac";
  return "other";
};

const probeClient = async (): Promise<boolean> => {
  for (const url of CLIENT_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${url}/printers`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // try next
    }
  }
  return false;
};

export default function ConnectPrinterSettings() {
  const { toast } = useToast();
  const os = useMemo(detectOS, []);
  const isMac = os === "mac";

  const [status, setStatus] = useState<Status>("checking");
  const [isDownloading, setIsDownloading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  // Persisted thermal printer settings — used by the print popup so it can
  // execute Fast Direct Thermal Print directly without prompting every time.
  const initial = useMemo(() => loadThermalSettings(), []);
  const [sizeId, setSizeId] = useState<ThermalLabelSizeId>(initial.sizeId);
  const [dpi, setDpi] = useState<Dpi>(initial.dpi);
  const [printerName, setPrinterName] = useState<string>(initial.printerName);
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>(initial.printerLanguage);
  const [availablePrinters, setAvailablePrinters] = useState<{ name: string }[]>([]);

  // Auto-save settings whenever they change so the popup always sees the
  // latest values without a manual "save" step.
  useEffect(() => {
    saveThermalSettings({ sizeId, dpi, printerName, printerLanguage });
  }, [sizeId, dpi, printerName, printerLanguage]);

  // Pull the printer list from the local print client so users can pick from
  // their actual installed printers instead of typing a name.
  const fetchPrinters = async () => {
    for (const url of CLIENT_URLS) {
      try {
        const res = await fetch(`${url}/printers`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data?.printers)) {
          setAvailablePrinters(data.printers);
          return;
        }
      } catch {
        // try next host
      }
    }
  };

  const refreshStatus = async () => {
    setIsChecking(true);
    setStatus("checking");
    const ok = await probeClient();
    setStatus(ok ? "connected" : "disconnected");
    if (ok) void fetchPrinters();
    setIsChecking(false);
  };

  useEffect(() => {
    if (isMac) return; // Skip polling — there's no client to connect to on Mac
    refreshStatus();
    const id = setInterval(async () => {
      const ok = await probeClient();
      setStatus((prev) => {
        const next: Status = ok ? "connected" : "disconnected";
        if (prev !== next && next === "connected") {
          toast({ title: "Printer connected", description: "SprintPrint is running." });
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac]);

  const handleConnect = async () => {
    if (status === "connected") {
      toast({ title: "Printer connected", description: "Print client is already running." });
      return;
    }
    await downloadPrintClient();
  };

  /** Download even when this machine is already connected — for setting up another one. */
  const handleDownloadAgain = () => downloadPrintClient();

  const downloadPrintClient = async () => {
    setIsDownloading(true);
    try {
      const { data, error } = await supabase.storage
        .from(PRINT_CLIENT_BUCKET)
        .createSignedUrl(PRINT_CLIENT_PATH, 60 * 10);

      if (error || !data?.signedUrl) {
        throw new Error(error?.message || "Could not generate download link");
      }

      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.download = PRINT_CLIENT_PATH;
      document.body.appendChild(a);
      a.click();
      a.remove();

      toast({
        title: "Downloading print client…",
        description: "Once downloaded, run SprintPrint.exe. The status here will flip to 'Connected' automatically.",
      });
    } catch (e) {
      toast({
        title: "Download failed",
        description: e instanceof Error ? e.message : "Please try again or contact support.",
        variant: "destructive",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  // ---------- macOS view ----------
  if (isMac) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white">Connect Printer</h2>
          <p className="text-sm text-gray-400 mt-1">
            Print FNSKU and shipping labels to your thermal printer directly from your Mac.
          </p>
        </div>

        <Card className="p-6 bg-white/5 border-white/10">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-lg bg-primary/15">
              <Apple className="h-6 w-6 text-primary" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-semibold text-white">Mac printing — use your browser's print dialog</h3>
                <Badge variant="outline" className="text-primary border-primary/40">
                  No install required
                </Badge>
              </div>

              <p className="text-sm text-gray-400 mt-2">
                The dedicated print client is currently Windows-only. Mac users get the same result by using your browser's built-in print dialog — labels render the same way and go straight to your thermal printer.
              </p>

              <div className="mt-5 text-xs text-gray-300 space-y-3 bg-black/20 border border-white/10 rounded-md p-4">
                <p className="font-medium text-white">One-time setup</p>
                <ol className="list-decimal pl-4 space-y-1.5 text-gray-400">
                  <li>
                    Plug in your thermal printer (e.g. Rollo, Zebra, DYMO) and add it in
                    <span className="text-white"> System Settings → Printers &amp; Scanners → Add Printer</span>.
                  </li>
                  <li>
                    Set the paper size to your label size (commonly <span className="text-white">2 × 1 in</span> for FNSKU labels).
                  </li>
                </ol>

                <p className="font-medium text-white pt-2">Each time you print labels</p>
                <ol className="list-decimal pl-4 space-y-1.5 text-gray-400">
                  <li>Generate the labels you want from any tool (FNSKU, Shipping, etc.).</li>
                  <li>
                    When the print preview opens, press <kbd className="px-1.5 py-0.5 bg-black/40 rounded border border-white/10 text-white">⌘ P</kbd> (Cmd + P).
                  </li>
                  <li>
                    Choose your thermal printer from the dropdown, confirm the paper size, then click <span className="text-white">Print</span>.
                  </li>
                </ol>

                <p className="text-[11px] text-gray-500 pt-2 border-t border-white/5">
                  💡 Tip: In the print dialog, expand <span className="text-gray-400">"Show Details"</span> and set
                  <span className="text-gray-400"> Scale: 100%</span> and
                  <span className="text-gray-400"> Margins: None</span> for crisp, properly-sized labels.
                </p>
              </div>

              <p className="text-xs text-gray-500 mt-4">
                A native Mac app (<code className="text-[11px] bg-black/30 px-1 py-0.5 rounded">InventorySprintPrintMac</code>) is on the roadmap. In the meantime, browser printing works reliably for all label sizes and printers.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ---------- Windows / other view ----------
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Connect Printer</h2>
        <p className="text-sm text-gray-400 mt-1">
          Install SprintPrint to send FNSKU and shipping labels directly to your thermal printer.
        </p>
      </div>

      <Card className="p-6 bg-white/5 border-white/10">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-lg bg-primary/15">
            <Printer className="h-6 w-6 text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">SprintPrint</h3>
              {status === "connected" && (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Printer connected
                </Badge>
              )}
              {status === "disconnected" && (
                <Badge variant="outline" className="text-gray-400 border-gray-600">
                  <XCircle className="h-3 w-3 mr-1" /> Disconnected
                </Badge>
              )}
              {status === "checking" && (
                <Badge variant="outline" className="text-gray-400 border-gray-600">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking…
                </Badge>
              )}
            </div>
            <p className="text-sm text-gray-400 mt-1">
              Lightweight Windows app that forwards labels to your local printer.
            </p>

            <div className="flex flex-wrap items-center gap-3 mt-4">
              <Button
                onClick={handleConnect}
                disabled={isDownloading}
                className="bg-primary hover:bg-primary/90"
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Preparing…
                  </>
                ) : status === "connected" ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" /> Connected
                  </>
                ) : (
                  // "Connect Printer" described something this button does not
                  // do. It fetches a signed URL and downloads SprintPrint.exe;
                  // the connection happens later, when the seller RUNS that
                  // file. Naming it Connect meant a Disconnected pill next to a
                  // Connect button read as "press this to connect", and pressing
                  // it appeared to do nothing.
                  <>
                    <Download className="h-4 w-4 mr-2" /> Download &amp; Connect
                  </>
                )}
              </Button>

              {/* Downloading is still useful once connected -- setting up a
                  SECOND machine is the common case, and the old UI had no way
                  to reach the installer from a machine that already worked. */}
              {status === "connected" && (
                <Button
                  variant="outline"
                  onClick={handleDownloadAgain}
                  disabled={isDownloading}
                  className="bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
                >
                  <Download className="h-4 w-4 mr-2" /> Download again
                </Button>
              )}

              <Button
                variant="outline"
                onClick={refreshStatus}
                disabled={isChecking}
                className="bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isChecking ? "animate-spin" : ""}`} />
                Recheck status
              </Button>
            </div>

            {status !== "connected" && (
              <div className="mt-5 text-xs text-gray-400 space-y-2 bg-black/20 border border-white/10 rounded-md p-3">
                <p className="font-medium text-gray-300">How it works:</p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Click <span className="text-white">Download &amp; Connect</span> — your browser downloads <code className="text-xs bg-black/40 px-1 rounded">SprintPrint.exe</code>.</li>
                  <li>Open the downloaded file and leave it running.</li>
                  <li>The status above switches to <span className="text-emerald-400">Printer connected</span> on its own — no need to click again.</li>
                </ol>
                {/* This block used to promise "After that the client auto-starts",
                    which is not true: nothing installs a startup entry, so the
                    client is gone after every reboot and the pill reads
                    Disconnected with no explanation. Saying so plainly is worth
                    more than the reassurance was. */}
                <p className="text-[11px] text-gray-500 pt-1">
                  Browsers can&apos;t launch desktop apps, so opening the file is a manual step.
                  <span className="text-amber-400/90"> It does not start automatically after a restart</span> — reopen it,
                  or put a shortcut in <code className="bg-black/40 px-1 rounded">shell:startup</code> to launch it on login.
                </p>
                <p className="text-[11px] text-gray-500">On macOS? Use your browser's print dialog (⌘P) instead — no install needed.</p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Thermal label printing settings — read by the print popup so it can
          execute Fast Direct Thermal Print directly without prompting. */}
      <Card className="p-6 bg-white/5 border-white/10">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-lg bg-primary/15">
            <Save className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-white">Thermal label printing settings</h3>
              <p className="text-sm text-gray-400 mt-1">
                Configured once here, applied automatically every time you print FNSKU labels. Saved instantly.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Label size</label>
                <Select value={sizeId} onValueChange={(v) => setSizeId(v as ThermalLabelSizeId)}>
                  <SelectTrigger className="bg-black/30 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THERMAL_LABEL_SIZES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Printer DPI</label>
                <Select value={String(dpi)} onValueChange={(v) => setDpi(Number(v) as Dpi)}>
                  <SelectTrigger className="bg-black/30 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="203">203 DPI</SelectItem>
                    <SelectItem value="300">300 DPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Windows printer</label>
                <Select value={printerName || "auto"} onValueChange={(v) => setPrinterName(v === "auto" ? "" : v)}>
                  <SelectTrigger className="bg-black/30 border-white/10 text-white">
                    <SelectValue placeholder="Auto-detect" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-detect thermal printer</SelectItem>
                    {availablePrinters.map((p) => (
                      <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-3">
                <label className="text-sm font-medium text-gray-300">Printer language</label>
                <Select value={printerLanguage} onValueChange={(v) => setPrinterLanguage(v as PrinterLanguage)}>
                  <SelectTrigger className="bg-black/30 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-detect (recommended) — Zebra → ZPL, Rollo/DYMO → Windows driver</SelectItem>
                    <SelectItem value="zpl">ZPL — Zebra printers (raw ZPL commands)</SelectItem>
                    <SelectItem value="gdi">Windows driver — Rollo, DYMO, Brother, generic thermal</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  If the print toast says "sent" but nothing prints, your printer doesn't speak ZPL. Switch to <strong className="text-gray-300">Windows driver</strong>.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-gray-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              Settings are saved automatically and used by the print popup.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
