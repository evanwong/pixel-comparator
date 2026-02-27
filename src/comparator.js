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
    if (result.originalUrl) {
      pageComparison.originalUrl = result.originalUrl;
    }
    if (result.redirectChain) {
      pageComparison.redirectChain = result.redirectChain;
    }
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
 * Builds one comparison per TikTok pixel ID × Meta pixel ID pair.
 * Results are grouped by TikTok pixel, with Meta comparisons sorted by health score (highest first).
 */
function comparePage(url, tiktok, meta) {
  // Build per-TikTok-pixel comparisons, each containing per-Meta-pixel sub-comparisons
  const pixelComparisons = [];

  for (const [ttPixelId, ttEvents] of Object.entries(tiktok.byPixelId)) {
    const metaComparisons = [];

    for (const [metaPixelId, metaEvts] of Object.entries(meta.byPixelId)) {
      const eventComparison = compareEvents(ttEvents, metaEvts);
      const paramComparison = compareParameters(ttEvents, metaEvts);
      const health = computePixelHealth(eventComparison, paramComparison, ttEvents, metaEvts);

      metaComparisons.push({
        metaPixelId,
        metaEventCount: metaEvts.length,
        metaEvents: metaEvts,
        eventComparison,
        paramComparison,
        health,
      });
    }

    // Sort by health score descending (highest match first)
    metaComparisons.sort((a, b) => b.health.score - a.health.score);

    pixelComparisons.push({
      tiktokPixelId: ttPixelId,
      tiktokEventCount: ttEvents.length,
      tiktokEvents: ttEvents,
      metaComparisons,
    });
  }

  // Collect Meta-only events (events that aren't matched by any TikTok pixel)
  const allTTEventNames = new Set();
  for (const pc of pixelComparisons) {
    for (const e of pc.tiktokEvents) {
      allTTEventNames.add(e.eventName);
      const equiv = EVENT_EQUIVALENCES[e.eventName];
      if (equiv) allTTEventNames.add(equiv);
    }
  }
  const metaOnlyEvents = meta.events.filter(
    (e) => !allTTEventNames.has(e.eventName)
  );

  const observations = generatePageObservations(url, tiktok, meta, pixelComparisons);

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
    pixelComparisons,
    metaOnlyEvents,
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

    // Compare parameters of the first occurrence on each side.
    // TikTok: only use eventData (from "properties") — allParams is transport noise.
    // Meta: only use customData (from "cd[...]") — allParams is transport noise.
    const ttParams = ttEvents.length > 0
      ? (ttEvents[0].eventData || {})
      : {};
    const fbParams = fbEvents.length > 0
      ? (fbEvents[0].customData || {})
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
 * Compute a health score (0–100) for how well a single TikTok pixel
 * aligns with Meta pixel events.
 */
function computePixelHealth(eventComparison, paramComparison, ttEvents, metaEvents) {
  const totalEvents = eventComparison.mapped.length;

  // --- Pixel presence (20 pts) ---
  let presenceScore = 0;
  if (ttEvents.length > 0) presenceScore += 10;
  if (metaEvents.length > 0) presenceScore += 10;

  // --- Event coverage (40 pts) ---
  let coverageScore = 0;
  if (totalEvents > 0) {
    const matchedOrMismatch = eventComparison.matched.length + eventComparison.countMismatch.length;
    coverageScore = Math.round((matchedOrMismatch / totalEvents) * 40);
  }

  // --- Event count parity (15 pts) ---
  let parityScore = 0;
  const eventsOnBoth = eventComparison.matched.length + eventComparison.countMismatch.length;
  if (eventsOnBoth > 0) {
    parityScore = Math.round((eventComparison.matched.length / eventsOnBoth) * 15);
  }

  // --- Parameter alignment (25 pts) ---
  let paramScore = 0;
  const bothSideParams = paramComparison.filter(
    (pc) => pc.matches.length + pc.differences.length > 0
  );
  if (bothSideParams.length > 0) {
    let totalCompared = 0;
    let totalMatched = 0;
    for (const pc of bothSideParams) {
      const compared = pc.matches.length + pc.differences.length;
      totalCompared += compared;
      totalMatched += pc.matches.length;
    }
    paramScore = totalCompared > 0 ? Math.round((totalMatched / totalCompared) * 25) : 25;
  } else if (eventsOnBoth > 0) {
    paramScore = 25;
  }

  const score = presenceScore + coverageScore + parityScore + paramScore;

  let rating, label, explanation;
  if (score >= 90) {
    rating = "excellent";
    label = "Excellent";
    explanation = "This TikTok pixel is very well aligned with Meta. Events and parameters are firing consistently.";
  } else if (score >= 70) {
    rating = "good";
    label = "Good";
    explanation = "Mostly aligned with minor differences. Review the gaps below.";
  } else if (score >= 45) {
    rating = "fair";
    label = "Fair";
    explanation = "Notable differences between this TikTok pixel and Meta. Several events or parameters are mismatched or missing.";
  } else if (score > 0) {
    rating = "poor";
    label = "Poor";
    explanation = "Significant mismatch. Many events are missing or firing with different parameters.";
  } else {
    rating = "none";
    label = "No Data";
    explanation = "No comparable events detected.";
  }

  // Build specific issue list
  const issues = [];
  if (eventComparison.tiktokOnly.length > 0) {
    issues.push(`${eventComparison.tiktokOnly.length} event(s) fire on TikTok only: ${eventComparison.tiktokOnly.map((e) => e.tiktokEvent).join(", ")}`);
  }
  if (eventComparison.metaOnly.length > 0) {
    issues.push(`${eventComparison.metaOnly.length} event(s) fire on Meta only: ${eventComparison.metaOnly.map((e) => e.metaEvent).join(", ")}`);
  }
  if (eventComparison.countMismatch.length > 0) {
    issues.push(`${eventComparison.countMismatch.length} event(s) fire a different number of times.`);
  }
  const paramDiffs = paramComparison.filter((pc) => pc.differences.length > 0);
  if (paramDiffs.length > 0) {
    issues.push(`${paramDiffs.length} event(s) have parameter value differences.`);
  }

  return {
    score,
    rating,
    label,
    explanation,
    issues,
    breakdown: { presenceScore, coverageScore, parityScore, paramScore },
  };
}

/**
 * Generate observations for a single page.
 */
function generatePageObservations(url, tiktok, meta, pixelComparisons) {
  const observations = [];

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

  // Aggregate observations from per-pixel-pair comparisons
  for (const pc of pixelComparisons) {
    const { tiktokPixelId, metaComparisons } = pc;

    for (const mc of metaComparisons) {
      const { metaPixelId, eventComparison, paramComparison } = mc;
      const label = `TT:${tiktokPixelId} vs Meta:${metaPixelId}`;

      if (eventComparison.tiktokOnly.length > 0) {
        const events = eventComparison.tiktokOnly.map((e) => e.tiktokEvent).join(", ");
        observations.push({
          type: "gap",
          message: `[${label}] Events firing on TikTok but NOT on Meta: ${events}`,
        });
      }

      if (eventComparison.metaOnly.length > 0) {
        const events = eventComparison.metaOnly.map((e) => e.metaEvent).join(", ");
        observations.push({
          type: "gap",
          message: `[${label}] Events firing on Meta but NOT on TikTok: ${events}`,
        });
      }

      for (const mismatch of eventComparison.countMismatch) {
        observations.push({
          type: "mismatch",
          message: `[${label}] "${mismatch.tiktokEvent}" fires ${mismatch.tiktokCount}x on TikTok but ${mismatch.metaCount}x on Meta.`,
        });
      }

      for (const paramDiff of paramComparison) {
        if (paramDiff.differences.length > 0) {
          const diffs = paramDiff.differences
            .map((d) => `${d.tiktokKey}="${d.tiktokValue}" vs ${d.metaKey}="${d.metaValue}"`)
            .join("; ");
          observations.push({
            type: "param_diff",
            message: `[${label}] Parameter differences in "${paramDiff.eventName}": ${diffs}`,
          });
        }
      }
    }
  }

  return observations;
}

/**
 * Generate overall observations across all pages.
 */
function generateOverallObservations(pages) {
  const observations = [];
  const pagesWithBoth = pages.filter(
    (p) => p.tiktok.eventCount > 0 && p.meta.eventCount > 0
  );

  // Critical: pages that have Meta pixel but NO TikTok pixel
  const metaButNoTikTok = pages.filter(
    (p) => p.meta.eventCount > 0 && p.tiktok.eventCount === 0
  );
  if (metaButNoTikTok.length > 0) {
    for (const p of metaButNoTikTok) {
      observations.push({
        type: "critical",
        message: `${p.url} — has Meta pixel but NO TikTok pixel`,
      });
    }
  }

  if (pagesWithBoth.length === pages.length) {
    observations.push({
      type: "good",
      message: "Both TikTok and Meta pixels are present on all scanned pages.",
    });
  }

  // Check for consistent event parity across all pixel-pair comparisons
  const allGaps = pages.flatMap((p) =>
    p.pixelComparisons.flatMap((pc) =>
      pc.metaComparisons.flatMap((mc) =>
        mc.eventComparison.tiktokOnly.concat(mc.eventComparison.metaOnly)
      )
    )
  );
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
