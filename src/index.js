#!/usr/bin/env node

const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");
const { interceptPixels } = require("./interceptor");
const { comparePixels } = require("./comparator");
const { generateReport } = require("./reporter");

const argv = yargs(hideBin(process.argv))
  .usage("Usage: $0 --urls <url1> <url2> ... [options]")
  .option("urls", {
    alias: "u",
    type: "array",
    describe: "One or more page URLs to scan for pixels",
    demandOption: true,
  })
  .option("output", {
    alias: "o",
    type: "string",
    describe: "Output file path for the HTML report",
    default: "pixel-report.html",
  })
  .option("timeout", {
    alias: "t",
    type: "number",
    describe: "Page load timeout in milliseconds",
    default: 30000,
  })
  .option("wait", {
    alias: "w",
    type: "number",
    describe: "Extra milliseconds to wait after page load for late-firing pixels",
    default: 3000,
  })
  .option("chrome", {
    type: "string",
    describe: "Path to Chrome/Chromium executable",
  })
  .example(
    "$0 --urls https://example.com https://example.com/shop",
    "Scan two pages and generate a report"
  )
  .example(
    "$0 -u https://example.com -o report.html --wait 5000",
    "Scan with 5s extra wait time"
  )
  .help()
  .alias("help", "h")
  .wrap(Math.min(100, yargs.terminalWidth?.() || 100))
  .parse();

async function main() {
  const { urls, output, timeout, wait, chrome } = argv;

  console.log("Pixel Comparator");
  console.log("=================");
  console.log(`Scanning ${urls.length} URL(s)...\n`);

  try {
    // Step 1: Intercept pixel network requests
    const scanResults = await interceptPixels(urls, {
      timeout,
      waitAfterLoad: wait,
      executablePath: chrome,
    });

    // Step 2: Compare TikTok vs Meta pixels
    const report = comparePixels(scanResults);

    // Step 3: Generate HTML report
    generateReport(report, output);

    // Print brief summary to console
    printSummary(report, scanResults);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (err.message.includes("executable") || err.message.includes("launch")) {
      console.error(
        "\nCould not launch Chrome. Ensure Chrome/Chromium is installed, or specify its path with --chrome."
      );
      console.error("  Example: pixel-comparator --urls https://example.com --chrome /usr/bin/chromium");
    }
    process.exit(1);
  }
}

function printSummary(report, scanResults) {
  const s = report.summary;

  // Count raw requests vs parsed events so the user sees what got filtered
  let rawTikTok = 0;
  let rawMeta = 0;
  for (const r of scanResults) {
    rawTikTok += r.tiktokRequests.length;
    rawMeta += r.metaRequests.length;
  }

  console.log("\n--- Summary ---");
  console.log(`Pages scanned:      ${s.pagesScanned}`);
  console.log(`TikTok pixel IDs:   ${s.tiktokPixelIds.length > 0 ? s.tiktokPixelIds.join(", ") : "none"}`);
  console.log(`Meta pixel IDs:     ${s.metaPixelIds.length > 0 ? s.metaPixelIds.join(", ") : "none"}`);
  console.log(`TikTok events:      ${s.totalTikTokEvents} (from ${rawTikTok} raw request${rawTikTok !== 1 ? "s" : ""})`);
  console.log(`Meta events:        ${s.totalMetaEvents} (from ${rawMeta} raw request${rawMeta !== 1 ? "s" : ""})`);

  if (rawTikTok !== s.totalTikTokEvents || rawMeta !== s.totalMetaEvents) {
    console.log(`  Note: Raw requests are filtered — internal events (LandingPageView, EngagedSession) and`);
    console.log(`        requests without a pixel ID are excluded from the event count.`);
  }

  if (s.overallObservations.length > 0) {
    console.log("\nObservations:");
    for (const obs of s.overallObservations) {
      console.log(`  • ${obs.message}`);
    }
  }
}

main();
