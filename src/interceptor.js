const puppeteer = require("puppeteer");
const https = require("https");
const http = require("http");

/**
 * Patterns for matching pixel network requests.
 * TikTok pixel fires to analytics.tiktok.com/api/v2/pixel
 * Meta/Facebook pixel fires to facebook.com/tr
 */
const TIKTOK_PATTERN = /analytics\.tiktok\.com\/api\/v2\/pixel/i;
const META_PATTERN = /facebook\.com\/tr/i;

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
 * Follow HTTP redirects (301/302/303/307/308) to resolve the final landing URL.
 * Uses GET requests (many ad servers ignore HEAD) and aborts the response body
 * immediately after reading status + headers to stay lightweight.
 *
 * @param {string} inputUrl - Starting URL that may redirect
 * @param {object} options
 * @param {number} options.maxRedirects - Max hops to follow (default 20)
 * @param {number} options.perHopTimeout - Per-request timeout in ms (default 10000)
 * @returns {Promise<{finalUrl: string, chain: string[]}>}
 */
async function resolveRedirects(inputUrl, { maxRedirects = 20, perHopTimeout = 5000 } = {}) {
  const chain = [inputUrl];
  let currentUrl = inputUrl;
  const visited = new Set([currentUrl]);

  for (let i = 0; i < maxRedirects; i++) {
    const parsedUrl = new URL(currentUrl);
    const client = parsedUrl.protocol === "https:" ? https : http;

    const result = await new Promise((resolve, reject) => {
      const req = client.request(currentUrl, {
        method: "GET",
        headers: { "User-Agent": CHROME_UA },
        timeout: perHopTimeout,
        rejectUnauthorized: false,
      }, (res) => {
        // Immediately destroy the socket — we only need status + headers
        res.destroy();
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).href;
          resolve({ redirect: true, nextUrl });
        } else {
          resolve({ redirect: false });
        }
      });
      req.on("error", (err) => {
        // Socket destruction above may cause ECONNRESET — that's expected, not an error
        if (err.code === "ECONNRESET") return;
        reject(err);
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("Redirect resolution timed out")); });
      req.end();
    });

    if (!result.redirect) break;

    if (visited.has(result.nextUrl)) {
      console.warn(`  Warning: circular redirect detected at ${result.nextUrl}`);
      break;
    }

    currentUrl = result.nextUrl;
    visited.add(currentUrl);
    chain.push(currentUrl);
  }

  return { finalUrl: currentUrl, chain };
}

/**
 * Scan a single page and capture pixel requests.
 * If the URL redirects, resolves the redirect chain first so that pixel
 * capture only covers the final landing page.
 */
async function scanPage(browser, url, { timeout, waitAfterLoad, proxyCredentials }) {
  // --- Phase 1: Try to resolve redirects via HTTP before pixel capture ---
  let targetUrl = url;
  let redirectChain = [];
  let httpResolutionFailed = false;

  try {
    const { finalUrl, chain } = await resolveRedirects(url);
    if (finalUrl !== url) {
      redirectChain = chain;
      targetUrl = finalUrl;
      console.log(`  Redirect chain (${chain.length - 1} hop${chain.length - 1 > 1 ? "s" : ""}):`);
      for (let i = 0; i < chain.length; i++) {
        const prefix = i === 0 ? "   " : "    →";
        const suffix = i === chain.length - 1 ? " (final)" : "";
        console.log(`${prefix} ${chain[i]}${suffix}`);
      }
    }
  } catch (err) {
    httpResolutionFailed = true;
    console.warn(`  Could not pre-resolve redirects via HTTP: ${err.message}`);
    console.warn(`  Will use browser to follow redirects`);
  }

  // --- Phase 2: Scan the resolved URL with pixel capture ---
  const page = await browser.newPage();

  if (proxyCredentials) {
    await page.authenticate(proxyCredentials);
  }

  // Some CDNs (e.g. Akamai) do JA3 TLS fingerprint matching: they block requests
  // where the User-Agent says Chrome but the TLS fingerprint matches a non-browser
  // client (which happens when an intercepting proxy re-encrypts traffic).
  // Workaround: send a non-browser UA at the HTTP level so the TLS fingerprint
  // matches, then override navigator.userAgent in JS so tracking scripts see Chrome.
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

  let response = null;
  try {
    response = await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout,
    });

    // --- Phase 2b: If HTTP resolution failed, detect redirects from browser ---
    if (httpResolutionFailed) {
      const browserUrl = page.url();
      if (browserUrl !== url) {
        targetUrl = browserUrl;
        // Try to get the redirect chain from Puppeteer's response
        const chain = response ? response.request().redirectChain() : [];
        if (chain.length > 0) {
          redirectChain = [url, ...chain.map((r) => r.url()), browserUrl];
          console.log(`  Browser followed redirect (${chain.length} hop${chain.length > 1 ? "s" : ""}):`);
          console.log(`    ${url}`);
          for (const req of chain) {
            console.log(`    → ${req.url()}`);
          }
          console.log(`    → ${browserUrl} (final)`);
        } else {
          redirectChain = [url, browserUrl];
          console.log(`  Redirected: ${url} → ${browserUrl}`);
        }
      }
    }

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
    // Even on error, try to capture where the browser ended up
    if (httpResolutionFailed) {
      try {
        const browserUrl = page.url();
        if (browserUrl && browserUrl !== "about:blank" && browserUrl !== url) {
          targetUrl = browserUrl;
          redirectChain = [url, browserUrl];
          console.log(`  Redirected (before error): ${url} → ${browserUrl}`);
        }
      } catch {}
    }
    console.warn(`  Warning: ${err.message}`);
  }

  await page.close();

  console.log(
    `  Captured ${tiktokRequests.length} TikTok raw request(s), ${metaRequests.length} Meta raw request(s)`
  );

  return {
    url: targetUrl,
    originalUrl: targetUrl !== url ? url : undefined,
    redirectChain: redirectChain.length > 0 ? redirectChain : undefined,
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
