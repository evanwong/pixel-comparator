# Pixel Comparator

Compare TikTok and Meta/Facebook pixel implementations across webpages. The tool loads pages in a headless browser, intercepts network calls to pixel endpoints, and generates an HTML report showing differences in events, parameters, and coverage.

## Requirements

- **Node.js** 18+
- **Chrome or Chromium** installed on your system (Puppeteer will download one automatically during `npm install`, or you can point to an existing installation with `--chrome`)

## Installation

```bash
npm install
```

## Usage

```bash
# Scan one or more URLs
node src/index.js --urls https://example.com https://example.com/shop

# Custom output path
node src/index.js --urls https://example.com -o my-report.html

# Longer wait for slow-loading pixels
node src/index.js --urls https://example.com --wait 5000

# Use a specific Chrome/Chromium binary
node src/index.js --urls https://example.com --chrome /usr/bin/chromium
```

### Options

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--urls` | `-u` | *(required)* | One or more page URLs to scan |
| `--output` | `-o` | `pixel-report.html` | Output file path for the HTML report |
| `--timeout` | `-t` | `30000` | Page load timeout in milliseconds |
| `--wait` | `-w` | `3000` | Extra ms to wait after load for late-firing pixels |
| `--chrome` | | | Path to Chrome/Chromium executable |

## How It Works

### 1. Network Interception

The tool launches a headless Chrome browser using Puppeteer and navigates to each URL you provide. It uses the Chrome DevTools Protocol (CDP) to listen for all outgoing network requests while the page loads. It waits for `networkidle2` (no more than 2 open connections for 500ms) plus a configurable extra delay to catch late-firing pixels.

Two patterns are matched:

- **TikTok pixel** — requests to `analytics.tiktok.com`
- **Meta pixel** — requests to `facebook.com/tr`

### 2. Pixel Parsing

Each intercepted request is parsed into a structured event:

**TikTok** (`src/parsers/tiktok.js`):
- Pixel ID extracted from `sdkid` or `pixel_code` query parameters
- Event name from `ev` or `event` parameter (e.g. `PageView`, `ViewContent`, `AddToCart`)
- Event data from `ed` parameter (JSON-encoded custom parameters like value, currency)
- Supports batched events where a single request contains multiple events

**Meta** (`src/parsers/meta.js`):
- Pixel ID from `id` query parameter (supports comma-separated multi-pixel batches)
- Event name from `ev` parameter (e.g. `PageView`, `ViewContent`, `Purchase`)
- Custom data from `cd[key]` parameters (e.g. `cd[value]=29.99`, `cd[currency]=USD`)
- User data from `ud[key]` parameters (hashed PII)

Events are grouped by pixel ID — a page can have zero or multiple pixel IDs per platform.

### 3. Comparison

The comparison engine (`src/comparator.js`) aligns events across the two platforms:

**Event mapping** — equivalent events are matched even when naming differs:

| TikTok | Meta |
|--------|------|
| `CompletePayment` | `Purchase` |
| `PlaceAnOrder` | `Purchase` |
| `SubmitForm` | `Lead` |

**Parameter mapping** — equivalent parameter keys are matched:

| TikTok | Meta |
|--------|------|
| `content_id` | `content_ids` |
| `quantity` | `num_items` |
| `query` | `search_string` |

The engine detects:
- **Events firing on one platform but not the other** (coverage gaps)
- **Event count mismatches** (e.g. `ViewContent` fires 2x on TikTok but 1x on Meta)
- **Parameter value differences** (same event, different values)
- **Platform-only parameters** (params sent by one pixel but not the other)
- **Multiple pixel IDs** per platform on the same page

### 4. HTML Report

The output is a standalone HTML file (no external dependencies) containing:

- **Summary cards** — total events, pixel IDs per platform
- **Event comparison table** — side-by-side view with match status badges
- **Parameter diff tables** — value-level comparison for matched events
- **Per-pixel-ID breakdown** — expandable sections showing every event and its parameters, grouped by pixel ID
- **Observations** — human-readable findings about gaps, mismatches, and coverage issues

## Example Output

After scanning a page with both pixels, the report might show:

```
Observations:
  • Events firing on TikTok but NOT on Meta: AddToCart
  • "ViewContent" fires 2x on TikTok but 1x on Meta
  • "ViewContent": TikTok sends parameters not found in Meta: content_category
```

## Project Structure

```
src/
├── index.js              CLI entry point
├── interceptor.js         Puppeteer network interception via CDP
├── comparator.js          Event & parameter comparison engine
├── reporter.js            HTML report generator
└── parsers/
    ├── tiktok.js          TikTok pixel request parser
    └── meta.js            Meta/Facebook pixel request parser
```
