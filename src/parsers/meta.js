/**
 * Meta/Facebook Pixel Parser
 *
 * Meta pixel fires requests to facebook.com/tr with events encoded
 * in query parameters (GET) or POST body.
 *
 * Common query parameters:
 *   - id: pixel ID
 *   - ev: event name (e.g. "PageView", "ViewContent", "Purchase")
 *   - cd[...]: custom data parameters (e.g. cd[value], cd[currency], cd[content_type])
 *   - dl: document location (page URL)
 *   - rl: referrer URL
 *   - ts: timestamp
 *   - sw / sh: screen width / height
 *   - ud[...]: user data (hashed email, phone, etc.)
 *   - v: pixel version
 *   - r: revision
 *   - ec: event count
 *   - it: initialization timestamp
 */

// Events to silently skip — internal/noise events not useful for comparison
const HIDDEN_EVENTS = new Set(["LandingPageView", "EngagedSession"]);

// Standard Meta pixel events
const META_STANDARD_EVENTS = [
  "PageView",
  "ViewContent",
  "Search",
  "AddToCart",
  "AddToWishlist",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  "Lead",
  "CompleteRegistration",
  "Contact",
  "CustomizeProduct",
  "Donate",
  "FindLocation",
  "Schedule",
  "StartTrial",
  "SubmitApplication",
  "Subscribe",
];

/**
 * Parse a list of raw Meta network requests into structured pixel events,
 * grouped by pixel ID.
 *
 * @param {object[]} requests - Raw request records from interceptor
 * @returns {object} Parsed result: { pixelIds: string[], events: object[], byPixelId: object }
 */
function parseMetaRequests(requests) {
  const events = [];

  for (const req of requests) {
    const parsed = parseSingleRequest(req);
    if (parsed) {
      for (const event of parsed) {
        if (HIDDEN_EVENTS.has(event.eventName)) continue;
        events.push(event);
      }
    }
  }

  // Group by pixel ID
  const byPixelId = {};
  for (const event of events) {
    const id = event.pixelId || "unknown";
    if (!byPixelId[id]) {
      byPixelId[id] = [];
    }
    byPixelId[id].push(event);
  }

  return {
    pixelIds: Object.keys(byPixelId),
    events,
    byPixelId,
  };
}

/**
 * Parse a single Meta request. A single request can contain multiple pixel IDs
 * (when the same event fires for multiple pixels, Meta batches them).
 */
function parseSingleRequest(req) {
  const params = mergeParams(req);
  const results = [];

  // Meta can batch multiple pixel IDs in a single request
  // Sometimes id contains comma-separated pixel IDs
  const rawId = params.id || "";
  const pixelIds = rawId.includes(",") ? rawId.split(",") : [rawId];

  for (const pixelId of pixelIds) {
    results.push(buildEvent(params, pixelId.trim(), req));
  }

  return results;
}

/**
 * Merge query and POST params, handling Meta's nested `cd[key]` format.
 */
function mergeParams(req) {
  const merged = { ...req.queryParams };

  // Also merge POST params if present
  if (req.postParams && typeof req.postParams === "object") {
    for (const [key, value] of Object.entries(req.postParams)) {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Build a structured event from raw parameters.
 */
function buildEvent(params, pixelId, req) {
  const eventName = params.ev || "unknown";

  // Extract custom data (cd[...] parameters)
  const customData = extractCustomData(params);

  // Extract user data (ud[...] parameters)
  const userData = extractPrefixedData(params, "ud");

  // Collect all parameters
  const allParams = extractAllParams(params);

  return {
    platform: "meta",
    pixelId: pixelId || null,
    eventName: normalizeEventName(eventName),
    eventCategory: categorizeEvent(eventName),
    customData,
    userData,
    allParams,
    pageUrl: params.dl || null,
    referrerUrl: params.rl || null,
    timestamp: params.ts || req.wallTime || null,
    pixelVersion: params.v || null,
    rawEndpoint: req.endpoint,
    rawUrl: req.fullUrl,
  };
}

/**
 * Extract cd[...] (custom data) parameters from the flat params object.
 * Meta encodes custom data like: cd[value]=29.99&cd[currency]=USD
 * After URL parsing these become keys like "cd[value]", "cd[currency]".
 */
function extractCustomData(params) {
  return extractPrefixedData(params, "cd");
}

/**
 * Extract parameters with a given prefix like "cd[key]" or "ud[key]".
 */
function extractPrefixedData(params, prefix) {
  const data = {};
  const pattern = new RegExp(`^${prefix}\\[(.+?)\\]$`);

  for (const [key, value] of Object.entries(params)) {
    const match = key.match(pattern);
    if (match) {
      const innerKey = match[1];
      // Try to parse JSON values
      try {
        data[innerKey] = JSON.parse(value);
      } catch {
        data[innerKey] = value;
      }
    }
  }

  return data;
}

/**
 * Normalize event names to a consistent format.
 */
function normalizeEventName(name) {
  if (!name) return "unknown";
  const map = {
    pageview: "PageView",
    page_view: "PageView",
    viewcontent: "ViewContent",
    view_content: "ViewContent",
    addtocart: "AddToCart",
    add_to_cart: "AddToCart",
    initiatecheckout: "InitiateCheckout",
    initiate_checkout: "InitiateCheckout",
    purchase: "Purchase",
    addpaymentinfo: "AddPaymentInfo",
    add_payment_info: "AddPaymentInfo",
    completeregistration: "CompleteRegistration",
    complete_registration: "CompleteRegistration",
    search: "Search",
    addtowishlist: "AddToWishlist",
    add_to_wishlist: "AddToWishlist",
    lead: "Lead",
    contact: "Contact",
    customizeproduct: "CustomizeProduct",
    customize_product: "CustomizeProduct",
    donate: "Donate",
    findlocation: "FindLocation",
    find_location: "FindLocation",
    schedule: "Schedule",
    starttrial: "StartTrial",
    start_trial: "StartTrial",
    submitapplication: "SubmitApplication",
    submit_application: "SubmitApplication",
    subscribe: "Subscribe",
  };

  return map[name.toLowerCase()] || name;
}

/**
 * Categorize an event for comparison purposes.
 */
function categorizeEvent(name) {
  const normalized = normalizeEventName(name);
  const categories = {
    pageview: ["PageView"],
    ecommerce: [
      "ViewContent",
      "AddToCart",
      "InitiateCheckout",
      "AddPaymentInfo",
      "Purchase",
      "AddToWishlist",
      "CustomizeProduct",
    ],
    engagement: ["Search", "Contact", "Donate", "Lead"],
    conversion: [
      "CompleteRegistration",
      "Subscribe",
      "StartTrial",
      "Schedule",
      "FindLocation",
      "SubmitApplication",
    ],
  };

  for (const [category, eventNames] of Object.entries(categories)) {
    if (eventNames.includes(normalized)) return category;
  }
  return "custom";
}

/**
 * Extract all meaningful parameters.
 */
function extractAllParams(params) {
  const meaningful = {};
  const skipKeys = new Set(["_", "nonce", "cache", "r"]);

  for (const [key, value] of Object.entries(params)) {
    if (skipKeys.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    meaningful[key] = value;
  }

  return meaningful;
}

module.exports = {
  parseMetaRequests,
  META_STANDARD_EVENTS,
  normalizeEventName,
  categorizeEvent,
};
