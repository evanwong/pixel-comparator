const puppeteer = require("puppeteer");

/**
 * Patterns for matching pixel network requests.
 * TikTok pixel fires to analytics.tiktok.com
 * Meta/Facebook pixel fires to facebook.com/tr
 */
const TIKTOK_PATTERN = /analytics\.tiktok\.com/i;
const META_PATTERN = /facebook\.com\/tr/i;

/**
 * Launch a browser, navigate to each URL, wait for full page load,
 * and capture all network requests matching TikTok or Meta pixel endpoints.
 *
 * @param {string[]} urls - List of page URLs to scan
 * @param {object} options
 * @param {number} options.timeout - Page load timeout in ms (default 30000)
 * @param {number} options.waitAfterLoad - Extra ms to wait after load for late-firing pixels (default 3000)
 * @param {string} options.executablePath - Path to Chrome/Chromium binary
 * @returns {Promise<object[]>} Array of per-URL results with captured requests
 */
async function interceptPixels(urls, options = {}) {
  const {
    timeout = 30000,
    waitAfterLoad = 3000,
    executablePath,
  } = options;

  const launchOptions = {
    headless: "shell",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await puppeteer.launch(launchOptions);
  const results = [];

  try {
    for (const url of urls) {
      console.log(`\nScanning: ${url}`);
      const pageResult = await scanPage(browser, url, { timeout, waitAfterLoad });
      results.push(pageResult);
    }
  } finally {
    await browser.close();
  }

  return results;
}

/**
 * Scan a single page and capture pixel requests.
 */
async function scanPage(browser, url, { timeout, waitAfterLoad }) {
  const page = await browser.newPage();

  // Set a realistic user agent to avoid bot detection
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  const tiktokRequests = [];
  const metaRequests = [];

  // Listen to all network requests via CDP
  const client = await page.createCDPSession();
  await client.send("Network.enable");

  client.on("Network.requestWillBeSent", (event) => {
    const requestUrl = event.request.url;

    if (TIKTOK_PATTERN.test(requestUrl)) {
      tiktokRequests.push(buildRequestRecord(event, "tiktok"));
    }

    if (META_PATTERN.test(requestUrl)) {
      metaRequests.push(buildRequestRecord(event, "meta"));
    }
  });

  try {
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });

    // Wait extra time for late-firing pixels (deferred events, etc.)
    await new Promise((resolve) => setTimeout(resolve, waitAfterLoad));
  } catch (err) {
    console.warn(`  Warning: ${err.message}`);
  }

  await page.close();

  console.log(
    `  Found ${tiktokRequests.length} TikTok request(s), ${metaRequests.length} Meta request(s)`
  );

  return {
    url,
    scannedAt: new Date().toISOString(),
    tiktokRequests,
    metaRequests,
  };
}

/**
 * Build a normalized record from a CDP Network.requestWillBeSent event.
 */
function buildRequestRecord(event, platform) {
  const { url, method, postData } = event.request;

  // Parse URL query parameters
  const urlObj = new URL(url);
  const queryParams = Object.fromEntries(urlObj.searchParams.entries());

  // Parse POST body if present
  let postParams = {};
  if (postData) {
    try {
      // Try JSON first
      postParams = JSON.parse(postData);
    } catch {
      // Fall back to URL-encoded form data
      try {
        postParams = Object.fromEntries(new URLSearchParams(postData).entries());
      } catch {
        postParams = { _raw: postData };
      }
    }
  }

  return {
    platform,
    method,
    fullUrl: url,
    endpoint: urlObj.pathname,
    queryParams,
    postParams,
    timestamp: event.timestamp,
    wallTime: event.wallTime,
  };
}

module.exports = { interceptPixels };
