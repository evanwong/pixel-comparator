/**
 * TikTok Pixel Parser
 *
 * TikTok pixel fires requests to analytics.tiktok.com with events encoded
 * in query parameters or POST body. Key endpoints:
 *   - /api/v2/pixel  (newer pixel)
 *   - /api/v1/pixel  (legacy)
 *
 * Common parameters:
 *   - sdkid / pixel_code: the pixel ID
 *   - ev / event: event name (e.g. "pageview", "ViewContent", "AddToCart")
 *   - ed / event_data: JSON-encoded event data with custom parameters
 *   - tt / timestamp
 *   - url / page_url: page where event fired
 */

// Standard TikTok pixel events for reference
const TIKTOK_STANDARD_EVENTS = [
  "pageview",
  "ViewContent",
  "ClickButton",
  "Search",
  "AddToWishlist",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "CompletePayment",
  "PlaceAnOrder",
  "Contact",
  "Download",
  "SubmitForm",
  "CompleteRegistration",
  "Subscribe",
  "CustomizeProduct",
  "FindLocation",
  "Schedule",
  "StartTrial",
];

/**
 * Parse a list of raw TikTok network requests into structured pixel events,
 * grouped by pixel ID.
 *
 * @param {object[]} requests - Raw request records from interceptor
 * @returns {object} Parsed result: { pixelIds: string[], events: object[], byPixelId: object }
 */
function parseTikTokRequests(requests) {
  const events = [];

  for (const req of requests) {
    const parsed = parseSingleRequest(req);
    if (parsed) {
      events.push(...parsed);
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
 * Parse a single TikTok request into one or more events.
 * A single request can batch multiple events.
 */
function parseSingleRequest(req) {
  const params = { ...req.queryParams, ...req.postParams };
  const results = [];

  // Try to detect batched events in the POST body
  if (params.data) {
    try {
      const batchData = typeof params.data === "string" ? JSON.parse(params.data) : params.data;
      if (Array.isArray(batchData)) {
        for (const item of batchData) {
          results.push(buildEvent(item, req));
        }
        return results;
      }
    } catch {
      // Not batched JSON, continue with flat parsing
    }
  }

  // Single event
  results.push(buildEvent(params, req));
  return results;
}

/**
 * Build a structured event from raw parameters.
 */
function buildEvent(params, req) {
  // Pixel ID can appear under multiple keys
  const pixelId =
    params.sdkid ||
    params.pixel_code ||
    params.pixelCode ||
    params.sdkVersion ||
    req.queryParams?.sdkid ||
    req.queryParams?.pixel_code ||
    null;

  // Event name
  const eventName =
    params.ev ||
    params.event ||
    params.event_name ||
    detectEventFromEndpoint(req.endpoint) ||
    "unknown";

  // Event data / custom parameters
  let eventData = {};
  const edRaw = params.ed || params.event_data || params.properties;
  if (edRaw) {
    if (typeof edRaw === "string") {
      try {
        eventData = JSON.parse(edRaw);
      } catch {
        eventData = { _raw: edRaw };
      }
    } else {
      eventData = edRaw;
    }
  }

  // Collect all recognizable parameters
  const allParams = extractAllParams(params);

  return {
    platform: "tiktok",
    pixelId,
    eventName: normalizeEventName(eventName),
    eventCategory: categorizeEvent(eventName),
    eventData,
    allParams,
    pageUrl: params.url || params.page_url || params.dl || null,
    timestamp: params.tt || params.timestamp || req.wallTime || null,
    rawEndpoint: req.endpoint,
    rawUrl: req.fullUrl,
  };
}

/**
 * Try to detect event type from the endpoint path.
 */
function detectEventFromEndpoint(endpoint) {
  if (!endpoint) return null;
  if (endpoint.includes("/batch")) return "batch";
  if (endpoint.includes("/track")) return "track";
  return null;
}

/**
 * Normalize event names to a consistent format.
 */
function normalizeEventName(name) {
  if (!name) return "unknown";
  // Map common variants
  const map = {
    pageview: "PageView",
    page_view: "PageView",
    Pageview: "PageView",
    viewcontent: "ViewContent",
    view_content: "ViewContent",
    addtocart: "AddToCart",
    add_to_cart: "AddToCart",
    initiatecheckout: "InitiateCheckout",
    initiate_checkout: "InitiateCheckout",
    completepayment: "CompletePayment",
    complete_payment: "CompletePayment",
    purchase: "CompletePayment",
    placeorder: "PlaceAnOrder",
    place_order: "PlaceAnOrder",
    addpaymentinfo: "AddPaymentInfo",
    add_payment_info: "AddPaymentInfo",
    completeregistration: "CompleteRegistration",
    complete_registration: "CompleteRegistration",
    search: "Search",
    addtowishlist: "AddToWishlist",
    add_to_wishlist: "AddToWishlist",
    clickbutton: "ClickButton",
    click_button: "ClickButton",
    submitform: "SubmitForm",
    submit_form: "SubmitForm",
    contact: "Contact",
    download: "Download",
    subscribe: "Subscribe",
    starttrial: "StartTrial",
    start_trial: "StartTrial",
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
      "CompletePayment",
      "PlaceAnOrder",
      "AddToWishlist",
      "CustomizeProduct",
    ],
    engagement: ["ClickButton", "Search", "SubmitForm", "Contact", "Download"],
    conversion: ["CompleteRegistration", "Subscribe", "StartTrial", "Schedule", "FindLocation"],
  };

  for (const [category, eventNames] of Object.entries(categories)) {
    if (eventNames.includes(normalized)) return category;
  }
  return "custom";
}

/**
 * Extract all meaningful parameters from a request.
 */
function extractAllParams(params) {
  const meaningful = {};
  const skipKeys = new Set([
    "_",
    "callback",
    "jsonp",
    "nonce",
    "cache",
    "r",
  ]);

  for (const [key, value] of Object.entries(params)) {
    if (skipKeys.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    meaningful[key] = value;
  }

  return meaningful;
}

module.exports = {
  parseTikTokRequests,
  TIKTOK_STANDARD_EVENTS,
  normalizeEventName,
  categorizeEvent,
};
