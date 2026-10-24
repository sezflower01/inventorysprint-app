# SprintPrint (Windows)

A lightweight Windows service that receives label print requests from the InventorySprint web app and sends ZPL commands directly to thermal printers (Zebra, Rollo, etc.).

## Requirements (end users)

- Windows 10 or 11 (x64)
- A thermal printer (Zebra, Rollo, or any ZPL-compatible printer) installed in Windows
- **No .NET install required** — the published .exe is fully self-contained

## Quick start (end user)

1. Get `SprintPrint.exe` and `Start-SprintPrint.bat` from your admin (or build once with the steps below).
2. Put both files in the same folder, e.g. `C:\InventorySprint\`.
3. **Double-click `Start-SprintPrint.bat`.** A console window opens and stays visible while the client runs.
4. Leave that window open while you print. Open the web app → Label Printing → status should turn **connected**.
5. (Optional) Drop a shortcut into `shell:startup` so it launches automatically on login.

## Build the self-contained .exe (one-time, on a dev machine)

Requirements for the build machine only:
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

Then from `print-clients/windows/`:

```bat
publish.bat
```

This produces a single self-contained executable at:

```
print-clients\windows\dist\SprintPrint.exe
```

Ship that one file to any Windows 10/11 x64 machine — no runtime install needed.

Manual equivalent (if you prefer running it directly):

```bash
dotnet publish -c Release -r win-x64 --self-contained true ^
  /p:PublishSingleFile=true ^
  /p:IncludeNativeLibrariesForSelfExtract=true ^
  /p:EnableCompressionInSingleFile=true ^
  -o dist
```

## Run

Double-click `Start-SprintPrint.bat` from the same folder as `SprintPrint.exe`.

It will listen on `http://localhost:7777/print-labels`.

If the window closes or startup fails, the launcher writes details to `%LOCALAPPDATA%\InventorySprint\PrintClient\launcher.log`.

The InventorySprint web app will call this endpoint when you click **Direct Thermal Print (Client)**.

The client looks for a printer whose name contains `Zebra` or `Rollo`. Configure your thermal printer in Windows with one of those names, or adjust `GetDefaultThermalPrinterName()` in `Program.cs`.

The web app can also call `http://localhost:7777/printers` to list installed Windows printers and let the user choose the exact printer.

## How It Works

1. The web app sends a POST request to `http://localhost:7777/print-labels` with label data
2. The client generates ZPL (Zebra Programming Language) commands for each label
3. ZPL is sent as RAW data directly to the thermal printer via Windows spooler
4. Labels print instantly without any Windows print dialog

## API Endpoint

### POST /print-labels

**Request Body:**
```json
{
      "sizeId": "2x1",
      "dpi": 203,
  "printerName": "Rollo Printer",
  "labels": [
    {
      "asin": "B08XYZ1234",
      "fnsku": "X001ABC123",
      "condition": "NEW",
      "title": "Product Title Here"
    }
  ]
}
```

**Parameters:**
- `sizeId` (optional): Label size - `"2x1"`, `"2.25x1.25"`, `"3x1"`, or `"3.5x2"`. Defaults to `"2x1"`
- `dpi` (optional): Printer DPI - `203` or `300`. Defaults to `203`
- `printerName` (optional): Specific printer name. If not provided, auto-detects Zebra or Rollo printer
- `labels`: Array of labels to print
  - `asin`: The product ASIN
  - `fnsku`: The FNSKU (used for barcode if present, otherwise ASIN is used)
  - `condition`: Product condition (e.g., "NEW", "LIKE_NEW")
  - `title`: Product title (truncated to 40 chars for label)

**Response:**
```json
{
  "success": true,
  "count": 1
}
```

### GET /printers

Returns installed Windows print queues so the web app can select `printerName` explicitly instead of relying only on Zebra/Rollo auto-detection.

## Supported Label Sizes

| Size ID | Dimensions | Common Use |
|---------|------------|------------|
| `2x1` | 2" × 1" | Standard FBA labels |
| `2.25x1.25` | 2.25" × 1.25" | Extended FBA labels |
| `3x1` | 3" × 1" | Wide labels |
| `3.5x2` | 3.5" × 2" | Larger thermal labels |

## Printer Auto-Detection

The client automatically detects thermal printers by looking for printer names containing:
- "Zebra"
- "Rollo"

You can override this by specifying the exact printer name in the request.

## Troubleshooting

### "No thermal printer found"
- Ensure your Zebra/Rollo printer is installed in Windows
- Check that the printer name contains "Zebra" or "Rollo"
- Alternatively, specify the exact printer name in your request

### Labels not printing
- Verify the printer is online and has labels loaded
- Check that the printer supports ZPL (most Zebra and Rollo printers do)
- Try printing a test page from Windows to confirm printer connectivity

### Connection refused errors
- Make sure the Print Client is running (check for `SprintPrint.exe` in Task Manager)
- Verify no firewall is blocking localhost:7777

## Running as a Background Service

For production use, you may want to run this as a Windows Service:

```bash
# Publish as self-contained executable
dotnet publish -c Release -r win-x64 --self-contained /p:PublishSingleFile=true

# Install as Windows Service (run as Administrator)
sc create InventorySprintPrint binPath="C:\path\to\SprintPrint.exe"
sc start InventorySprintPrint
```

## Security Note

This client listens only on `localhost:7777` and is not accessible from other machines. CORS is configured to allow requests from any origin to support browser-based requests from the web app.
