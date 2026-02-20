const { parseTikTokRequests } = require("./parsers/tiktok");
const { parseMetaRequests } = require("./parsers/meta");

/**
 * Event name equivalences between TikTok and Meta pixels.
 * Maps TikTok event names to their Meta equivalents.
 */
const EVENT_EQUIVALENCES = {
  PageView: "PageView",
  ViewContent: "ViewContent",
  Search: "Search",
  AddToCart: "AddToCart",
  AddToWishlist: "AddToWishlist",
  InitiateCheckout: "InitiateCheckout",
  AddPaymentInfo: "AddPaymentInfo",
  CompletePayment: "Purchase", // TikTok "CompletePayment" = Meta "Purchase"
  PlaceAnOrder: "Purchase", // TikTok "PlaceAnOrder" can also map to Meta "Purchase"
  CompleteRegistration: "CompleteRegistration",
  Contact: "Contact",
  SubmitForm: "Lead", // TikTok "SubmitForm" ~ Meta "Lead"
  Subscribe: "Subscribe",
  StartTrial: "StartTrial",
  Schedule: "Schedule",
  FindLocation: "FindLocation",
  CustomizeProduct: "CustomizeProduct",
  Download: "Download",
  ClickButton: "ClickButton",
};

/**
 * Parameter equivalences between TikTok and Meta custom data keys.
 */
const PARAM_EQUIVALENCES = {
  // TikTok param -> Meta cd[param]
  value: "value",
  currency: "currency",
  content_type: "content_type",
  content_id: "content_ids",
  content_name: "content_name",
  content_category: "content_category",
  quantity: "num_items",
  price: "value",
  query: "search_string",
  description: "content_name",
  order_id: "order_id",
};

/**
 * Compare TikTok and Meta pixel data for a list of scanned page results.
 *
 * @param {object[]} scanResults - Array of per-URL scan results from interceptor
 * @returns {object} Full comparison report
 */
function comparePixels(scanResults) {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {},
    pages: [],
  };

  let totalTikTokEvents = 0;
  let totalMetaEvents = 0;
  const allTikTokPixelIds = new Set();
  const allMetaPixelIds = new Set();

  for (const result of scanResults) {
    const tiktok = parseTikTokRequests(result.tiktokRequests);
    const meta = parseMetaRequests(result.metaRequests);

    tiktok.pixelIds.forEach((id) => allTikTokPixelIds.add(id));
    meta.pixelIds.forEach((id) => allMetaPixelIds.add(id));
    totalTikTokEvents += tiktok.events.length;
    totalMetaEvents += meta.events.length;

    const pageComparison = comparePage(result.url, tiktok, meta);
    report.pages.push(pageComparison);
  }

  report.summary = {
    pagesScanned: scanResults.length,
    tiktokPixelIds: [...allTikTokPixelIds],
    metaPixelIds: [...allMetaPixelIds],
    totalTikTokEvents,
    totalMetaEvents,
    overallObservations: generateOverallObservations(report.pages),
  };

  return report;
}

/**
 * Compare pixel data for a single page.
 */
function comparePage(url, tiktok, meta) {
  const eventComparison = compareEvents(tiktok.events, meta.events);
  const paramComparison = compareParameters(tiktok.events, meta.events);
  const observations = generatePageObservations(url, tiktok, meta, eventComparison, paramComparison);

  return {
    url,
    tiktok: {
      pixelIds: tiktok.pixelIds,
      eventCount: tiktok.events.length,
      events: tiktok.events,
      byPixelId: tiktok.byPixelId,
    },
    meta: {
      pixelIds: meta.pixelIds,
      eventCount: meta.events.length,
      events: meta.events,
      byPixelId: meta.byPixelId,
    },
    eventComparison,
    paramComparison,
    observations,
  };
}

/**
 * Compare events between TikTok and Meta, finding matches and gaps.
 */
function compareEvents(tiktokEvents, metaEvents) {
  // Count event types on each side
  const tiktokEventCounts = countBy(tiktokEvents, (e) => e.eventName);
  const metaEventCounts = countBy(metaEvents, (e) => e.eventName);

  // Map TikTok events to their Meta equivalents for comparison
  const mapped = [];
  const allEventNames = new Set([
    ...Object.keys(tiktokEventCounts),
    ...Object.keys(metaEventCounts),
  ]);

  for (const eventName of allEventNames) {
    const tiktokCount = tiktokEventCounts[eventName] || 0;
    const metaEquivalent = EVENT_EQUIVALENCES[eventName] || eventName;
    const metaCount = metaEventCounts[metaEquivalent] || metaEventCounts[eventName] || 0;

    // Check reverse mapping too
    const reverseMetaCount = metaEventCounts[eventName] || 0;
    const isMetaOnly =
      tiktokCount === 0 &&
      !Object.values(EVENT_EQUIVALENCES).includes(eventName) &&
      reverseMetaCount > 0;

    mapped.push({
      tiktokEvent: tiktokCount > 0 ? eventName : findTikTokEquivalent(eventName),
      metaEvent: metaCount > 0 || reverseMetaCount > 0 ? eventName : metaEquivalent,
      tiktokCount,
      metaCount: metaCount || reverseMetaCount,
      status: getMatchStatus(tiktokCount, metaCount || reverseMetaCount),
      isEquivalent: eventName !== metaEquivalent,
      note: eventName !== metaEquivalent ? `TikTok "${eventName}" ≈ Meta "${metaEquivalent}"` : "",
    });
  }

  // Deduplicate by combining rows that represent the same logical event
  const deduped = deduplicateMappedEvents(mapped);

  return {
    mapped: deduped,
    tiktokOnly: deduped.filter((m) => m.status === "tiktok_only"),
    metaOnly: deduped.filter((m) => m.status === "meta_only"),
    matched: deduped.filter((m) => m.status === "matched"),
    countMismatch: deduped.filter((m) => m.status === "count_mismatch"),
  };
}

/**
 * Find the TikTok event name that maps to a given Meta event.
 */
function findTikTokEquivalent(metaEventName) {
  for (const [tiktok, meta] of Object.entries(EVENT_EQUIVALENCES)) {
    if (meta === metaEventName) return tiktok;
  }
  return metaEventName;
}

/**
 * Deduplicate mapped events by combining equivalent event pairs.
 */
function deduplicateMappedEvents(mapped) {
  const seen = new Set();
  const result = [];

  for (const item of mapped) {
    const key = `${item.tiktokEvent}|${item.metaEvent}`;
    const reverseKey = `${item.metaEvent}|${item.tiktokEvent}`;
    if (seen.has(key) || seen.has(reverseKey)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

/**
 * Compare parameters between matched events.
 */
function compareParameters(tiktokEvents, metaEvents) {
  const comparisons = [];

  // Group events by normalized event name
  const tiktokByEvent = groupBy(tiktokEvents, (e) => e.eventName);
  const metaByEvent = groupBy(metaEvents, (e) => e.eventName);

  const allEvents = new Set([...Object.keys(tiktokByEvent), ...Object.keys(metaByEvent)]);

  for (const eventName of allEvents) {
    const ttEvents = tiktokByEvent[eventName] || [];
    const metaEquivalent = EVENT_EQUIVALENCES[eventName] || eventName;
    const fbEvents = metaByEvent[metaEquivalent] || metaByEvent[eventName] || [];

    // Compare parameters of the first occurrence on each side
    const ttParams = ttEvents.length > 0
      ? (ttEvents[0].eventData && Object.keys(ttEvents[0].eventData).length > 0
          ? ttEvents[0].eventData
          : ttEvents[0].allParams || {})
      : {};
    const fbParams = fbEvents.length > 0
      ? (fbEvents[0].customData && Object.keys(fbEvents[0].customData).length > 0
          ? fbEvents[0].customData
          : fbEvents[0].allParams || {})
      : {};

    // For events present on both platforms, diff their params
    if (ttEvents.length > 0 && fbEvents.length > 0) {
      const paramDiff = diffParameters(ttParams, fbParams, eventName);
      comparisons.push({
        eventName,
        metaEquivalent,
        ...paramDiff,
      });
    } else if (ttEvents.length > 0) {
      // TikTok-only event: list all params as tiktokOnly
      comparisons.push({
        eventName,
        metaEquivalent,
        matches: [],
        differences: [],
        tiktokOnly: Object.entries(ttParams).map(([key, value]) => ({ key, value })),
        metaOnly: [],
      });
    } else if (fbEvents.length > 0) {
      // Meta-only event: list all params as metaOnly
      comparisons.push({
        eventName,
        metaEquivalent,
        matches: [],
        differences: [],
        tiktokOnly: [],
        metaOnly: Object.entries(fbParams).map(([key, value]) => ({ key, value })),
      });
    }
  }

  return comparisons;
}

/**
 * Diff parameters between TikTok and Meta for a given event.
 */
function diffParameters(ttParams, fbParams, eventName) {
  const tiktokOnly = [];
  const metaOnly = [];
  const differences = [];
  const matches = [];

  const ttKeys = Object.keys(ttParams);
  const fbKeys = Object.keys(fbParams);

  // Check TikTok params against Meta equivalents
  for (const ttKey of ttKeys) {
    const fbKey = PARAM_EQUIVALENCES[ttKey] || ttKey;
    if (fbKeys.includes(fbKey) || fbKeys.includes(ttKey)) {
      const actualFbKey = fbKeys.includes(fbKey) ? fbKey : ttKey;
      const ttVal = String(ttParams[ttKey]);
      const fbVal = String(fbParams[actualFbKey]);

      if (ttVal === fbVal) {
        matches.push({ tiktokKey: ttKey, metaKey: actualFbKey, value: ttVal });
      } else {
        differences.push({
          tiktokKey: ttKey,
          metaKey: actualFbKey,
          tiktokValue: ttVal,
          metaValue: fbVal,
        });
      }
    } else {
      tiktokOnly.push({ key: ttKey, value: ttParams[ttKey] });
    }
  }

  // Find Meta-only params
  for (const fbKey of fbKeys) {
    const hasTTEquiv = ttKeys.some(
      (ttKey) => (PARAM_EQUIVALENCES[ttKey] || ttKey) === fbKey || ttKey === fbKey
    );
    if (!hasTTEquiv) {
      metaOnly.push({ key: fbKey, value: fbParams[fbKey] });
    }
  }

  return { matches, differences, tiktokOnly, metaOnly };
}

/**
 * Get match status between event counts.
 */
function getMatchStatus(tiktokCount, metaCount) {
  if (tiktokCount > 0 && metaCount > 0) {
    return tiktokCount === metaCount ? "matched" : "count_mismatch";
  }
  if (tiktokCount > 0) return "tiktok_only";
  return "meta_only";
}

/**
 * Generate observations for a single page.
 */
function generatePageObservations(url, tiktok, meta, eventComparison, paramComparison) {
  const observations = [];

  // Pixel presence
  if (tiktok.events.length === 0 && meta.events.length === 0) {
    observations.push({
      type: "warning",
      message: "No TikTok or Meta pixels detected on this page.",
    });
    return observations;
  }

  if (tiktok.events.length === 0) {
    observations.push({
      type: "warning",
      message: "No TikTok pixel detected. Only Meta pixel is firing.",
    });
  }

  if (meta.events.length === 0) {
    observations.push({
      type: "warning",
      message: "No Meta pixel detected. Only TikTok pixel is firing.",
    });
  }

  // Multiple pixel IDs
  if (tiktok.pixelIds.length > 1) {
    observations.push({
      type: "info",
      message: `Multiple TikTok pixel IDs detected: ${tiktok.pixelIds.join(", ")}`,
    });
  }

  if (meta.pixelIds.length > 1) {
    observations.push({
      type: "info",
      message: `Multiple Meta pixel IDs detected: ${meta.pixelIds.join(", ")}`,
    });
  }

  // Event gaps
  if (eventComparison.tiktokOnly.length > 0) {
    const events = eventComparison.tiktokOnly.map((e) => e.tiktokEvent).join(", ");
    observations.push({
      type: "gap",
      message: `Events firing on TikTok but NOT on Meta: ${events}`,
    });
  }

  if (eventComparison.metaOnly.length > 0) {
    const events = eventComparison.metaOnly.map((e) => e.metaEvent).join(", ");
    observations.push({
      type: "gap",
      message: `Events firing on Meta but NOT on TikTok: ${events}`,
    });
  }

  // Count mismatches
  for (const mismatch of eventComparison.countMismatch) {
    observations.push({
      type: "mismatch",
      message: `"${mismatch.tiktokEvent}" fires ${mismatch.tiktokCount}x on TikTok but ${mismatch.metaCount}x on Meta.`,
    });
  }

  // Parameter differences
  for (const paramDiff of paramComparison) {
    if (paramDiff.differences.length > 0) {
      const diffs = paramDiff.differences
        .map((d) => `${d.tiktokKey}="${d.tiktokValue}" vs ${d.metaKey}="${d.metaValue}"`)
        .join("; ");
      observations.push({
        type: "param_diff",
        message: `Parameter value differences in "${paramDiff.eventName}": ${diffs}`,
      });
    }

    if (paramDiff.tiktokOnly.length > 0) {
      const keys = paramDiff.tiktokOnly.map((p) => p.key).join(", ");
      observations.push({
        type: "param_gap",
        message: `"${paramDiff.eventName}": TikTok sends parameters not found in Meta: ${keys}`,
      });
    }

    if (paramDiff.metaOnly.length > 0) {
      const keys = paramDiff.metaOnly.map((p) => p.key).join(", ");
      observations.push({
        type: "param_gap",
        message: `"${paramDiff.eventName}": Meta sends parameters not found in TikTok: ${keys}`,
      });
    }
  }

  return observations;
}

/**
 * Generate overall observations across all pages.
 */
function generateOverallObservations(pages) {
  const observations = [];
  const pagesWithNoTikTok = pages.filter((p) => p.tiktok.eventCount === 0);
  const pagesWithNoMeta = pages.filter((p) => p.meta.eventCount === 0);
  const pagesWithBoth = pages.filter(
    (p) => p.tiktok.eventCount > 0 && p.meta.eventCount > 0
  );

  if (pagesWithNoTikTok.length > 0) {
    observations.push({
      type: "coverage",
      message: `${pagesWithNoTikTok.length} of ${pages.length} page(s) have no TikTok pixel.`,
    });
  }

  if (pagesWithNoMeta.length > 0) {
    observations.push({
      type: "coverage",
      message: `${pagesWithNoMeta.length} of ${pages.length} page(s) have no Meta pixel.`,
    });
  }

  if (pagesWithBoth.length === pages.length) {
    observations.push({
      type: "good",
      message: "Both TikTok and Meta pixels are present on all scanned pages.",
    });
  }

  // Check for consistent event parity across pages
  const allGaps = pages.flatMap((p) => p.eventComparison.tiktokOnly.concat(p.eventComparison.metaOnly));
  if (allGaps.length > 0) {
    const uniqueGaps = new Set(allGaps.map((g) => g.tiktokEvent || g.metaEvent));
    observations.push({
      type: "summary",
      message: `Across all pages, ${uniqueGaps.size} event type(s) are not firing consistently on both platforms.`,
    });
  }

  return observations;
}

// Utility functions
function countBy(arr, fn) {
  const counts = {};
  for (const item of arr) {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function groupBy(arr, fn) {
  const groups = {};
  for (const item of arr) {
    const key = fn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

module.exports = { comparePixels, EVENT_EQUIVALENCES, PARAM_EQUIVALENCES };
