const puppeteer = require("puppeteer");

/**
 * Patterns for matching pixel network requests.
 * TikTok pixel fires to analytics.tiktok.com/api/v2/pixel
 * Meta/Facebook pixel fires to facebook.com/tr
 */
const TIKTOK_PATTERN = /analytics\.tiktok\.com\/api\/v2\/pixel/i;
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

  // Parse proxy from environment for Chromium
  let proxyCredentials = null;
  const proxyEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  let proxyServer = null;
  if (proxyEnv) {
    try {
      const proxyUrl = new URL(proxyEnv);
      proxyServer = `${proxyUrl.hostname}:${proxyUrl.port}`;
      if (proxyUrl.username) {
        proxyCredentials = {
          username: decodeURIComponent(proxyUrl.username),
          password: decodeURIComponent(proxyUrl.password),
        };
      }
    } catch {}
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--ignore-certificate-errors",
  ];
  if (proxyServer) {
    launchArgs.push(`--proxy-server=${proxyServer}`);
  }

  const launchOptions = {
    headless: true,
    args: launchArgs,
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await puppeteer.launch(launchOptions);
  const results = [];

  try {
    for (const url of urls) {
      console.log(`\nScanning: ${url}`);
      const pageResult = await scanPage(browser, url, { timeout, waitAfterLoad, proxyCredentials });
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
async function scanPage(browser, url, { timeout, waitAfterLoad, proxyCredentials }) {
  const page = await browser.newPage();

  // Authenticate with proxy if credentials are available
  if (proxyCredentials) {
    await page.authenticate(proxyCredentials);
  }

  // Some CDNs (e.g. Akamai) do JA3 TLS fingerprint matching: they block requests
  // where the User-Agent says Chrome but the TLS fingerprint matches a non-browser
  // client (which happens when an intercepting proxy re-encrypts traffic).
  // Workaround: send a non-browser UA at the HTTP level so the TLS fingerprint
  // matches, then override navigator.userAgent in JS so tracking scripts see Chrome.
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const httpUA = proxyCredentials ? "curl/8.5.0" : CHROME_UA;
  await page.setUserAgent(httpUA);
  if (proxyCredentials) {
    await page.evaluateOnNewDocument((ua) => {
      Object.defineProperty(navigator, "userAgent", { get: () => ua });
      Object.defineProperty(navigator, "appVersion", { get: () => ua.replace("Mozilla/", "") });
    }, CHROME_UA);
  }

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

    // Dismiss cookie consent banners so consent-gated pixels can fire
    for (const sel of [
      "#onetrust-accept-btn-handler",
      ".onetrust-close-btn-handler",
      ".ot-sdk-btn-handler",
      "[aria-label='Close']",
    ]) {
      try { await page.click(sel); break; } catch {}
    }

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
