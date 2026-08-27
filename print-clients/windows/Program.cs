using System.Drawing.Printing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Serialization;
using System.Windows.Forms;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

// ---- Always log to a file so silent crashes can be diagnosed ----
static string LogPath()
{
    var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArbiProSeller", "PrintClient");
    Directory.CreateDirectory(folder);
    return Path.Combine(folder, "print-client.log");
}
static void LogLine(string msg)
{
    try { File.AppendAllText(LogPath(), $"{DateTimeOffset.Now:u}  {msg}{Environment.NewLine}"); } catch { }
}

LogLine("=== Startup ===");

AppDomain.CurrentDomain.UnhandledException += (s, e) =>
{
    var ex = e.ExceptionObject as Exception;
    LogLine($"UNHANDLED: {ex}");
    try { MessageBox.Show($"SprintPrint crashed:\n\n{ex?.Message}\n\nLog: {LogPath()}", "Print Client Error", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
};

try
{
    // Auto-kill any previous instance so we never hit "port in use"
    try
    {
        var me = System.Diagnostics.Process.GetCurrentProcess();
        foreach (var p in System.Diagnostics.Process.GetProcessesByName(me.ProcessName))
        {
            if (p.Id != me.Id)
            {
                try { p.Kill(true); p.WaitForExit(2000); LogLine($"Killed previous instance pid={p.Id}"); } catch { }
            }
        }
        System.Threading.Thread.Sleep(500);
    }
    catch (Exception ex) { LogLine($"Cleanup warning: {ex.Message}"); }

    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddCors(options =>
    {
        options.AddDefaultPolicy(policy =>
        {
            policy
                .SetIsOriginAllowed(_ => true)
                .AllowAnyHeader()
                .AllowAnyMethod()
                .WithExposedHeaders("*");
        });
    });

    builder.WebHost.UseUrls("http://127.0.0.1:7777");

    var app = builder.Build();
    app.UseCors();

    app.Use(async (context, next) =>
    {
        var origin = context.Request.Headers["Origin"].ToString();
        if (!string.IsNullOrWhiteSpace(origin))
        {
            context.Response.Headers["Access-Control-Allow-Origin"] = origin;
            context.Response.Headers["Vary"] = "Origin";
        }
        context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";

        if (context.Request.Method == "OPTIONS")
        {
            context.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            context.Response.Headers["Access-Control-Allow-Headers"] = "*";
            context.Response.Headers["Access-Control-Max-Age"] = "86400";
            context.Response.StatusCode = 204;
            return;
        }
        await next();
    });

    static string? GetDefaultThermalPrinterName()
    {
        foreach (string printer in PrinterSettings.InstalledPrinters)
        {
            if (IsThermalPrinterName(printer)) return printer;
        }
        return null;
    }

    static bool IsThermalPrinterName(string printer)
    {
        return printer.Contains("Zebra", StringComparison.OrdinalIgnoreCase) ||
               printer.Contains("Rollo", StringComparison.OrdinalIgnoreCase) ||
               printer.Contains("DYMO", StringComparison.OrdinalIgnoreCase) ||
               printer.Contains("Brother", StringComparison.OrdinalIgnoreCase) ||
               printer.Contains("Label", StringComparison.OrdinalIgnoreCase) ||
               printer.Contains("Thermal", StringComparison.OrdinalIgnoreCase);
    }

    app.MapGet("/health", () =>
    {
        var printerName = GetDefaultThermalPrinterName();
        if (string.IsNullOrEmpty(printerName)) return Results.Json(new { status = "no-printer" });
        return Results.Json(new { status = "ok", printer = printerName, printerName });
    });

    app.MapGet("/printers", () =>
    {
        var defaultPrinter = new PrinterSettings().PrinterName;
        var printers = PrinterSettings.InstalledPrinters
            .Cast<string>()
            .Select(name => new
            {
                name,
                isDefault = name.Equals(defaultPrinter, StringComparison.OrdinalIgnoreCase),
                isThermalCandidate = IsThermalPrinterName(name)
            })
            .OrderByDescending(p => p.isThermalCandidate)
            .ThenByDescending(p => p.isDefault)
            .ThenBy(p => p.name)
            .ToList();
        return Results.Json(new { printers });
    });

    static bool ShouldUseGdi(string printerName, string? mode)
    {
        var m = (mode ?? "auto").ToLowerInvariant();
        if (m == "zpl") return false;
        if (m == "gdi" || m == "driver" || m == "windows") return true;
        if (printerName.Contains("Zebra", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    app.MapPost("/print-labels", (PrintRequest request) =>
    {
        var printerName = request.PrinterName ?? GetDefaultThermalPrinterName();
        LogLine($"/print-labels called. requestedPrinter='{request.PrinterName}', resolvedPrinter='{printerName}', mode='{request.Mode}', size='{request.SizeId}', count={request.Labels?.Count ?? 0}");

        if (string.IsNullOrWhiteSpace(printerName))
        {
            var installed = string.Join(", ", PrinterSettings.InstalledPrinters.Cast<string>());
            var msg = $"No thermal printer found. Installed printers: [{installed}]. Pass printerName explicitly.";
            LogLine(msg);
            return Results.Json(new { success = false, error = msg }, statusCode: 400);
        }

        var sizeId = request.SizeId ?? "2x1";
        var dpi = request.Dpi ?? 203;
        var useGdi = ShouldUseGdi(printerName, request.Mode);
        LogLine($"Using {(useGdi ? "GDI (Windows driver)" : "ZPL (RAW)")} for printer '{printerName}'");

        int printed = 0;
        try
        {
            foreach (var label in request.Labels!)
            {
                var barcode = label.Fnsku ?? label.Asin;
                var condition = (label.Condition ?? "NEW").ToUpperInvariant();
                var title = label.Title ?? "";

                if (useGdi)
                {
                    LogLine($"GDI print: printer='{printerName}', barcode='{barcode}', size='{sizeId}'");
                    GdiLabelPrinter.Print(printerName, barcode, title, condition, sizeId);
                }
                else
                {
                    var zpl = ZplBuilder.BuildLabel(barcode, title, condition, sizeId, dpi);
                    LogLine($"ZPL print: printer='{printerName}', bytes={zpl.Length}");
                    RawPrinterHelper.SendStringToPrinter(printerName, zpl);
                }
                printed++;
            }

            LogLine($"Print job submitted successfully. count={printed}, printer='{printerName}', mode={(useGdi ? "gdi" : "zpl")}");
            return Results.Ok(new { success = true, count = printed, mode = useGdi ? "gdi" : "zpl", printer = printerName });
        }
        catch (Exception ex)
        {
            LogLine($"PRINT ERROR after {printed}/{request.Labels!.Count} labels: {ex}");
            return Results.Json(new
            {
                success = false,
                error = ex.Message,
                printer = printerName,
                mode = useGdi ? "gdi" : "zpl",
                printedBeforeError = printed,
                detail = ex.ToString()
            }, statusCode: 500);
        }
    });

    // WYSIWYG path: the web app rasterizes <ProductLabel> to a PNG and posts the
    // base64 image here. The EXE makes ZERO layout decisions — it just stretches
    // the bitmap to fill the configured paper size. This is the ONLY way to keep
    // the printed output identical to the on-screen preview.
    app.MapPost("/print-image-labels", (ImagePrintRequest request) =>
    {
        var printerName = request.PrinterName ?? GetDefaultThermalPrinterName();
        LogLine($"/print-image-labels called. requestedPrinter='{request.PrinterName}', resolvedPrinter='{printerName}', size='{request.SizeId}', count={request.Images?.Count ?? 0}");

        if (string.IsNullOrWhiteSpace(printerName))
        {
            var installed = string.Join(", ", PrinterSettings.InstalledPrinters.Cast<string>());
            var msg = $"No printer found. Installed printers: [{installed}]. Pass printerName explicitly.";
            LogLine(msg);
            return Results.Json(new { success = false, error = msg }, statusCode: 400);
        }

        if (request.Images == null || request.Images.Count == 0)
        {
            return Results.Json(new { success = false, error = "No images supplied." }, statusCode: 400);
        }

        // Resolve target paper size in inches from sizeId (defaults to 2x1 thermal).
        double widthIn, heightIn;
        switch (request.SizeId)
        {
            case "2.25x1.25": widthIn = 2.25; heightIn = 1.25; break;
            case "3x1":       widthIn = 3.0;  heightIn = 1.0;  break;
            case "3.5x2":     widthIn = 3.5;  heightIn = 2.0;  break;
            case "2x1":
            default:          widthIn = 2.0;  heightIn = 1.0;  break;
        }

        int printed = 0;
        try
        {
            foreach (var dataUrl in request.Images)
            {
                var bytes = ImageLabelPrinter.DecodeDataUrl(dataUrl);
                LogLine($"IMG print: printer='{printerName}', size='{request.SizeId}', bytes={bytes.Length}");
                ImageLabelPrinter.Print(printerName, bytes, widthIn, heightIn);
                printed++;
            }

            LogLine($"Image print job submitted successfully. count={printed}, printer='{printerName}'");
            return Results.Ok(new { success = true, count = printed, mode = "image", printer = printerName });
        }
        catch (Exception ex)
        {
            LogLine($"IMAGE PRINT ERROR after {printed}/{request.Images.Count} labels: {ex}");
            return Results.Json(new
            {
                success = false,
                error = ex.Message,
                printer = printerName,
                mode = "image",
                printedBeforeError = printed,
                detail = ex.ToString()
            }, statusCode: 500);
        }
    });

    // Test endpoint: print a known-good label to the auto-detected printer.
    app.MapPost("/test-print", () =>
    {
        var printerName = GetDefaultThermalPrinterName();
        LogLine($"/test-print called. resolvedPrinter='{printerName}'");
        if (string.IsNullOrWhiteSpace(printerName))
        {
            var installed = string.Join(", ", PrinterSettings.InstalledPrinters.Cast<string>());
            return Results.Json(new { success = false, error = "No thermal printer detected", installed }, statusCode: 400);
        }
        try
        {
            var useGdi = ShouldUseGdi(printerName, "auto");
            if (useGdi)
                GdiLabelPrinter.Print(printerName, "TEST123456", "ArbiProSeller Test Label", "NEW", "2x1");
            else
                RawPrinterHelper.SendStringToPrinter(printerName, ZplBuilder.BuildLabel("TEST123456", "ArbiProSeller Test Label", "NEW", "2x1", 203));
            LogLine($"Test print submitted to '{printerName}' via {(useGdi ? "GDI" : "ZPL")}");
            return Results.Ok(new { success = true, printer = printerName, mode = useGdi ? "gdi" : "zpl" });
        }
        catch (Exception ex)
        {
            LogLine($"TEST PRINT ERROR: {ex}");
            return Results.Json(new { success = false, error = ex.Message, detail = ex.ToString(), printer = printerName }, statusCode: 500);
        }
    });

    LogLine("Starting web host on http://127.0.0.1:7777");
    app.StartAsync().GetAwaiter().GetResult();
    LogLine("Web host started. Launching tray icon.");

    using var exitSignal = new ManualResetEventSlim(false);
    Exception? uiException = null;

    var uiThread = new Thread(() =>
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using var trayIcon = new NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Application,
                Visible = true,
                Text = "SprintPrint — running on http://127.0.0.1:7777"
            };

            var menu = new ContextMenuStrip();
            var header = new ToolStripMenuItem("SprintPrint") { Enabled = false };
            menu.Items.Add(header);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Status: Running on port 7777", null, (s, e) =>
            {
                MessageBox.Show($"Print client is running.\n\nURL: http://127.0.0.1:7777\nLog: {LogPath()}", "SprintPrint", MessageBoxButtons.OK, MessageBoxIcon.Information);
            });
            menu.Items.Add("Print test label", null, (s, e) =>
            {
                try
                {
                    var printerName = GetDefaultThermalPrinterName();
                    if (string.IsNullOrWhiteSpace(printerName))
                    {
                        var installed = string.Join("\n  - ", PrinterSettings.InstalledPrinters.Cast<string>());
                        MessageBox.Show($"No thermal printer detected.\n\nInstalled printers:\n  - {installed}\n\nRename your printer to include 'Rollo', 'Zebra', 'DYMO', 'Label', or 'Thermal'.", "Test Print", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    var useGdi = ShouldUseGdi(printerName, "auto");
                    if (useGdi)
                        GdiLabelPrinter.Print(printerName, "TEST123456", "ArbiProSeller Test Label", "NEW", "2x1");
                    else
                        RawPrinterHelper.SendStringToPrinter(printerName, ZplBuilder.BuildLabel("TEST123456", "ArbiProSeller Test Label", "NEW", "2x1", 203));
                    MessageBox.Show($"Test label sent to:\n{printerName}\n\nMode: {(useGdi ? "Windows driver (GDI)" : "Raw ZPL")}\n\nIf nothing prints, check the Windows print queue for this printer.", "Test Print", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch (Exception ex)
                {
                    LogLine($"Tray test print error: {ex}");
                    MessageBox.Show($"Test print failed:\n\n{ex.Message}\n\nFull error written to log.", "Test Print Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            });
            menu.Items.Add("Open log file", null, (s, e) =>
            {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(LogPath()) { UseShellExecute = true }); } catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, (s, e) =>
            {
                LogLine("Quit requested from tray.");
                trayIcon.Visible = false;
                Application.ExitThread();
            });
            trayIcon.ContextMenuStrip = menu;

            trayIcon.BalloonTipTitle = "SprintPrint";
            trayIcon.BalloonTipText = "Running on http://127.0.0.1:7777 — right-click the tray icon for options.";
            trayIcon.ShowBalloonTip(4000);

            Application.Run();
        }
        catch (Exception ex)
        {
            uiException = ex;
            LogLine($"Tray UI crashed: {ex}");
            try { MessageBox.Show($"Print client tray failed:\n\n{ex.Message}\n\nLog: {LogPath()}", "Print Client Error", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
        }
        finally
        {
            exitSignal.Set();
        }
    });
    uiThread.SetApartmentState(ApartmentState.STA);
    uiThread.IsBackground = false;
    uiThread.Start();

    exitSignal.Wait();
    if (uiException != null) Environment.Exit(1);

    LogLine("Stopping web host.");
    app.StopAsync().GetAwaiter().GetResult();
}
catch (Exception ex)
{
    LogLine($"FATAL: {ex}");
    var logPath = PrintClientDiagnostics.WriteStartupError(ex);
    var msg = PrintClientDiagnostics.IsPortInUseFailure(ex)
        ? $"Port 7777 is already in use. The print client may already be running.\n\nLog: {logPath}"
        : $"{ex.Message}\n\nLog: {logPath}";
    try { MessageBox.Show(msg, "SprintPrint — could not start", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
}

// ----------------- Models -----------------

public class PrintRequest
{
    [JsonPropertyName("sizeId")]
    public string? SizeId { get; set; } // "2x1", "2.25x1.25", "3x1", "3.5x2"

    [JsonPropertyName("dpi")]
    public int? Dpi { get; set; } // 203 or 300

    [JsonPropertyName("printerName")]
    public string? PrinterName { get; set; }

    [JsonPropertyName("mode")]
    public string? Mode { get; set; } // "auto" | "zpl" | "gdi"

    [JsonPropertyName("labels")]
    public List<PrintLabel> Labels { get; set; } = new();
}

public class PrintLabel
{
    [JsonPropertyName("asin")]
    public string Asin { get; set; } = "";

    [JsonPropertyName("fnsku")]
    public string? Fnsku { get; set; }

    [JsonPropertyName("condition")]
    public string? Condition { get; set; }

    [JsonPropertyName("title")]
    public string Title { get; set; } = "";
}

public class ImagePrintRequest
{
    [JsonPropertyName("sizeId")]
    public string? SizeId { get; set; } // "2x1", "2.25x1.25", "3x1", "3.5x2"

    [JsonPropertyName("printerName")]
    public string? PrinterName { get; set; }

    // Each entry is a data URL: "data:image/png;base64,...."
    [JsonPropertyName("images")]
    public List<string> Images { get; set; } = new();
}

public static class PrintClientDiagnostics
{
    public static bool IsPortInUseFailure(Exception ex)
    {
        var text = ex.ToString();
        return text.Contains("address already in use", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("Only one usage of each socket address", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("failed to bind", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("127.0.0.1:7777", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("localhost:7777", StringComparison.OrdinalIgnoreCase);
    }

    public static string WriteStartupError(Exception ex)
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArbiProSeller", "PrintClient");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "startup-error.log");
        File.WriteAllText(path, $"{DateTimeOffset.Now:u}{Environment.NewLine}{ex}{Environment.NewLine}");
        return path;
    }
}

// ----------------- ZPL Builder -----------------

public static class ZplBuilder
{
    public static string BuildLabel(string barcode, string title, string condition, string sizeId, int dpi)
    {
        dpi = dpi == 300 ? 300 : 203;
        int labelWidthDots;
        int labelHeightDots;

        switch (sizeId)
        {
            case "2.25x1.25":
                labelWidthDots = ToDots(2.25, dpi);
                labelHeightDots = ToDots(1.25, dpi);
                break;
            case "3x1":
                labelWidthDots = 3 * dpi;
                labelHeightDots = 1 * dpi;
                break;
            case "3.5x2":
                labelWidthDots = ToDots(3.5, dpi);
                labelHeightDots = 2 * dpi;
                break;
            case "2x1":
            default:
                labelWidthDots = 2 * dpi;
                labelHeightDots = 1 * dpi;
                break;
        }

        // 90, not 40. The old cap was never the binding constraint anyway: the
        // ^FB below allowed a single line, and at font width 16 on a 2x1 label
        // only ~20 characters fit on it -- six of which are the "New - "
        // prefix. So roughly 14 characters of title reached the label, which is
        // three or four words. Raising the cap without also raising the line
        // count would have changed nothing.
        //
        // 90 = 3 lines x ~29 characters at the condensed width set below.
        var maxTitleLength = 90;
        if (title.Length > maxTitleLength)
        {
            title = title.Substring(0, maxTitleLength);
        }

        condition = condition.ToUpperInvariant().Contains("NEW") ? "New" : condition.ToUpperInvariant();

        var sb = new StringBuilder();

        sb.AppendLine("^XA");                 // start label
        sb.AppendLine($"^PW{labelWidthDots}");// label width
        sb.AppendLine($"^LL{labelHeightDots}");// label length
        sb.AppendLine("^LH0,0");             // label home (0,0)

        var scale = dpi / 203.0;
        int x = (int)Math.Round(labelWidthDots * 0.10);
        int topY = (int)Math.Round(4 * scale);
        // Three lines of titleFontH plus inter-line spacing. On 2x1 @ 203dpi
        // this is 57 dots, leaving 65..126 for the barcode and ~151 total of
        // the 203 available -- the human-readable barcode text fits under it
        // with margin to spare.
        int topTextHeight = Math.Max((int)Math.Round(57 * scale), (int)Math.Round(labelHeightDots * 0.28));
        int barcodeY = topY + topTextHeight + (int)Math.Round(4 * scale);
        int barcodeHeight = Math.Max((int)Math.Round(28 * scale), (int)Math.Round(labelHeightDots * 0.30));
        // Height and width set INDEPENDENTLY. ^A0N takes both, and the old code
        // passed the same value for each, giving square glyphs 16 dots wide.
        // Usable width on a 2x1 @ 203dpi is 326 dots (406 minus 10% margins
        // each side), so 16-wide characters meant ~20 per line.
        //
        // Condensing to 11 wide while keeping 15 tall gives ~29 characters per
        // line and stays legible -- narrowing glyphs costs far less readability
        // than shrinking them vertically would.
        int titleFontH = Math.Max(12, (int)Math.Round(15 * scale));
        int titleFontW = Math.Max(9, (int)Math.Round(11 * scale));
        var topText = $"{condition} - {title}";

        // Condition + title first so printer bottom clipping cannot hide it.
        sb.AppendLine($"^FO{x},{topY}");
        sb.AppendLine($"^A0N,{titleFontH},{titleFontW}");
        // 3 lines instead of 1, and left-aligned instead of centred: wrapped
        // text is much easier to read ragged-right than centred, where every
        // line starts at a different x.
        sb.AppendLine($"^FB{labelWidthDots - (x * 2)},3,0,L,0");
        sb.AppendLine($"^FD{topText}^FS");

        // Barcode CODE128 under the title, intentionally smaller to leave visible title space.
        sb.AppendLine($"^BY{(dpi == 300 ? 2 : 1)},2,0");
        sb.AppendLine($"^FO{x},{barcodeY}");
        sb.AppendLine($"^BCN,{barcodeHeight},Y,N,N");
        sb.AppendLine($"^FD{barcode}^FS");

        sb.AppendLine("^XZ"); // end label

        return sb.ToString();
    }

    private static int ToDots(double inches, int dpi) => (int)Math.Round(inches * dpi, MidpointRounding.AwayFromZero);
}

// ----------------- Raw Printer Helper -----------------

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? pDocName;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW",
        SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter",
        SetLastError = true, ExactSpelling = true)]
    public static extern bool ClosePrinter(IntPtr h);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW",
        SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern bool StartDocPrinter(
        IntPtr h, int level, [In] DOCINFO di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter",
        SetLastError = true, ExactSpelling = true)]
    public static extern bool EndDocPrinter(IntPtr h);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter",
        SetLastError = true, ExactSpelling = true)]
    public static extern bool StartPagePrinter(IntPtr h);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter",
        SetLastError = true, ExactSpelling = true)]
    public static extern bool EndPagePrinter(IntPtr h);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter",
        SetLastError = true, ExactSpelling = true)]
    public static extern bool WritePrinter(
        IntPtr h, IntPtr pBytes, int dwCount, out int dwWritten);

    public static bool SendStringToPrinter(string printerName, string zpl)
    {
        IntPtr pBytes = IntPtr.Zero;
        IntPtr hPrinter = IntPtr.Zero;

        try
        {
            if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
                throw new Exception("Could not open printer: " + printerName);

            var di = new DOCINFO
            {
                pDocName = "ArbiProSeller Label",
                pDataType = "RAW"
            };

            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("Could not start document.");

            if (!StartPagePrinter(hPrinter))
                throw new Exception("Could not start page.");

            var bytes = Encoding.ASCII.GetBytes(zpl);
            var length = bytes.Length;

            pBytes = Marshal.AllocCoTaskMem(length);
            Marshal.Copy(bytes, 0, pBytes, length);

            if (!WritePrinter(hPrinter, pBytes, length, out var written) || written != length)
            {
                throw new Exception("Failed to write to printer.");
            }

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
            return true;
        }
        finally
        {
            if (pBytes != IntPtr.Zero)
                Marshal.FreeCoTaskMem(pBytes);

            if (hPrinter != IntPtr.Zero)
                ClosePrinter(hPrinter);
        }
    }
}

// ----------------- Helper to pick a printer (moved above app definitions) -----------------


// ----------------- GDI Label Printer (for Rollo / DYMO / non-ZPL drivers) -----------------

public static class GdiLabelPrinter
{
    public static void Print(string printerName, string barcode, string title, string condition, string sizeId)
    {
        // Label dimensions in inches
        double widthIn, heightIn;
        switch (sizeId)
        {
            case "2.25x1.25": widthIn = 2.25; heightIn = 1.25; break;
            case "3x1":       widthIn = 3.0;  heightIn = 1.0;  break;
            case "3.5x2":     widthIn = 3.5;  heightIn = 2.0;  break;
            case "2x1":
            default:          widthIn = 2.0;  heightIn = 1.0;  break;
        }

        // PaperSize uses hundredths of an inch
        var paperWidth  = (int)Math.Round(widthIn  * 100);
        var paperHeight = (int)Math.Round(heightIn * 100);

        using var pd = new System.Drawing.Printing.PrintDocument();
        pd.PrinterSettings.PrinterName = printerName;
        pd.DocumentName = "ArbiProSeller Label";

        var paper = new System.Drawing.Printing.PaperSize("Label", paperWidth, paperHeight);
        pd.DefaultPageSettings.PaperSize = paper;
        pd.DefaultPageSettings.Margins = new System.Drawing.Printing.Margins(0, 0, 0, 0);
        pd.OriginAtMargins = false;

        pd.PrintPage += (sender, e) =>
        {
            var g = e.Graphics!;
            g.PageUnit = System.Drawing.GraphicsUnit.Inch;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;

            float padX = 0.16f;
            float labelW = (float)widthIn;
            float labelH = (float)heightIn;
            float drawW = labelW - padX * 2;

            // Layout: condition/title first, with the barcode reduced to leave guaranteed visible text room.
            // 0.30in, not 0.18in. Arial 6.5pt runs ~0.09in per line, so 0.18in
            // held 1.7 lines -- and LineLimit below refuses to draw a partial
            // line, so exactly ONE printed and the rest was ellipsed. 0.30in
            // fits three whole lines.
            float titleRowH = Math.Max(0.30f, labelH * 0.30f);
            float barcodeH = Math.Max(0.20f, labelH * 0.32f);
            float y = 0.02f;

            var normalizedCondition = condition.ToUpperInvariant().Contains("NEW") ? "New" : condition.ToUpperInvariant();
            var topText = $"{normalizedCondition} - {title}";
            // 6.5pt: ~37 characters per line across the 1.68in draw width,
            // versus ~32 at 7.5pt. Combined with three lines that is ~111
            // characters against the ~26 that used to reach the label.
            using (var f = new System.Drawing.Font("Arial", 6.5f, System.Drawing.FontStyle.Bold, System.Drawing.GraphicsUnit.Point))
            {
                var sf = new System.Drawing.StringFormat
                {
                    // Near, not Center: see the ZPL note above -- centred
                    // wrapped text is harder to scan than ragged-right.
                    Alignment = System.Drawing.StringAlignment.Near,
                    Trimming = System.Drawing.StringTrimming.EllipsisCharacter,
                    FormatFlags = System.Drawing.StringFormatFlags.LineLimit
                };
                g.DrawString(topText, f, System.Drawing.Brushes.Black, new System.Drawing.RectangleF(padX, y, drawW, titleRowH), sf);
            }
            y += titleRowH + 0.02f;

            // Render barcode to a bitmap at high DPI then draw scaled
            using (var bmp = Code128Renderer.Render(barcode, widthPx: 650, heightPx: 120))
            {
                g.DrawImage(bmp, new System.Drawing.RectangleF(padX, y, drawW, barcodeH));
            }
            y += barcodeH + 0.02f;

            // Human-readable barcode text
            using (var f = new System.Drawing.Font("Arial", 7f, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point))
            {
                var sf = new System.Drawing.StringFormat { Alignment = System.Drawing.StringAlignment.Center };
                g.DrawString(barcode, f, System.Drawing.Brushes.Black, new System.Drawing.RectangleF(padX, y, drawW, 0.13f), sf);
            }

            e.HasMorePages = false;
        };

        pd.Print();
    }
}

// Minimal Code128 (subset B) renderer producing a bitmap.
public static class Code128Renderer
{
    // Code128 patterns (107 entries: 0..102 + Start A/B/C + Stop)
    private static readonly string[] Patterns = new[] {
        "11011001100","11001101100","11001100110","10010011000","10010001100","10001001100","10011001000","10011000100","10001100100","11001001000",
        "11001000100","11000100100","10110011100","10011011100","10011001110","10111001100","10011101100","10011100110","11001110010","11001011100",
        "11001001110","11011100100","11001110100","11101101110","11101001100","11100101100","11100100110","11101100100","11100110100","11100110010",
        "11011011000","11011000110","11000110110","10100011000","10001011000","10001000110","10110001000","10001101000","10001100010","11010001000",
        "11000101000","11000100010","10110111000","10110001110","10001101110","10111011000","10111000110","10001110110","11101110110","11010001110",
        "11000101110","11011101000","11011100010","11011101110","11101011000","11101000110","11100010110","11101101000","11101100010","11100011010",
        "11101111010","11001000010","11110001010","10100110000","10100001100","10010110000","10010000110","10000101100","10000100110","10110010000",
        "10110000100","10011010000","10011000010","10000110100","10000110010","11000010010","11001010000","11110111010","11000010100","10001111010",
        "10100111100","10010111100","10010011110","10111100100","10011110100","10011110010","11110100100","11110010100","11110010010","11011011110",
        "11011110110","11110110110","10101111000","10100011110","10001011110","10111101000","10111100010","11110101000","11110100010","10111011110",
        "10111101110","11101011110","11110101110","11010000100","11010010000","11010011100","1100011101011"
    };

    public static System.Drawing.Bitmap Render(string data, int widthPx, int heightPx)
    {
        // Build code values for subset B
        var values = new List<int>();
        values.Add(104); // Start B
        int sum = 104;
        for (int i = 0; i < data.Length; i++)
        {
            int v = data[i] - 32;
            if (v < 0 || v > 95) v = 0;
            values.Add(v);
            sum += v * (i + 1);
        }
        int checksum = sum % 103;
        values.Add(checksum);
        values.Add(106); // Stop

        var bits = new System.Text.StringBuilder();
        foreach (var v in values) bits.Append(Patterns[v]);

        var bmp = new System.Drawing.Bitmap(widthPx, heightPx);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.Clear(System.Drawing.Color.White);
            float moduleW = (float)widthPx / bits.Length;
            float x = 0;
            for (int i = 0; i < bits.Length; i++)
            {
                if (bits[i] == '1')
                {
                    g.FillRectangle(System.Drawing.Brushes.Black, x, 0, moduleW + 0.5f, heightPx);
                }
                x += moduleW;
            }
        }
        return bmp;
    }
}

// ----------------- Image Label Printer (WYSIWYG bitmap path) -----------------
// The web app pre-renders the entire label (title, barcode, condition, layout)
// to a PNG using the same React component shown in the preview. We just stretch
// that PNG to the configured paper size — no fonts, no layout decisions here.
public static class ImageLabelPrinter
{
    public static byte[] DecodeDataUrl(string dataUrl)
    {
        if (string.IsNullOrWhiteSpace(dataUrl))
            throw new ArgumentException("Empty image payload.");

        var commaIdx = dataUrl.IndexOf(',');
        var base64 = commaIdx >= 0 ? dataUrl.Substring(commaIdx + 1) : dataUrl;
        return Convert.FromBase64String(base64);
    }

    public static void Print(string printerName, byte[] pngBytes, double widthIn, double heightIn)
    {
        // PaperSize uses hundredths of an inch.
        var paperWidth  = (int)Math.Round(widthIn  * 100);
        var paperHeight = (int)Math.Round(heightIn * 100);

        using var ms = new MemoryStream(pngBytes);
        using var image = System.Drawing.Image.FromStream(ms);

        using var pd = new System.Drawing.Printing.PrintDocument();
        pd.PrinterSettings.PrinterName = printerName;
        pd.DocumentName = "ArbiProSeller Label";

        var paper = new System.Drawing.Printing.PaperSize("Label", paperWidth, paperHeight);
        pd.DefaultPageSettings.PaperSize = paper;
        pd.DefaultPageSettings.Margins = new System.Drawing.Printing.Margins(0, 0, 0, 0);
        pd.OriginAtMargins = false;

        // Capture by ref so the lambda sees a fresh image instance per page.
        var img = image;
        pd.PrintPage += (sender, e) =>
        {
            var g = e.Graphics!;
            g.PageUnit = System.Drawing.GraphicsUnit.Inch;
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;

            // Stretch the bitmap edge-to-edge across the full label area.
            g.DrawImage(img, new System.Drawing.RectangleF(0f, 0f, (float)widthIn, (float)heightIn));

            e.HasMorePages = false;
        };

        pd.Print();
    }
}
