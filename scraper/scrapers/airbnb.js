/**
 * Airbnb Host Profile Scraper
 *
 * Scrapes the host's profile page (airbnb.com/users/show/ID or
 * airbnb.com/users/profile/ID) rather than individual listings.
 *
 * Strategy:
 * - Load the host profile page
 * - Find all listing cards shown on the profile
 * - Sum review counts across all listings to get a total
 * - Delta vs previous run = new reviews gained (calculated in index.js)
 *
 * Both URL formats supported:
 *   https://www.airbnb.com/users/show/17313548
 *   https://www.airbnb.com/users/profile/1470524939373852171
 */

const { createStealthPage, humanScroll, sleep } = require('../browser');

async function scrapeAirbnb(browser, url, targetMonth) {
  const { page, context } = await createStealthPage(browser);

  try {
    console.log(`    → ${url}`);

    // Normalise URL — both /show/ and /profile/ work the same way
    const profileUrl = normaliseAirbnbUrl(url);

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500 + Math.random() * 2000);

    await dismissOverlays(page);
    await sleep(500);

    // Scroll down to load all listings (lazy-loaded)
    await loadAllListings(page);

    const total = await ReviewCounts(page, profileUrl);

    if (total === null) {
      throw new Error('Could not extract any review counts from Airbnb profile page');
    }

    console.log(`    📊  Airbnb total reviews across all listings: ${total}`);
    return { type: 'total', count: total };

  } finally {
    await context.close();
  }
}

function normaliseAirbnbUrl(url) {
  // Accept both formats — just ensure no trailing params that break loading
  try {
    const u = new URL(url);
    // Keep only the path — strip query params that might redirect
    return `https://www.airbnb.com${u.pathname}`;
  } catch {
    return url;
  }
}

async function loadAllListings(page) {
  // Scroll gradually to trigger lazy-load of all listing cards
  let prevHeight = 0;
  let unchangedPasses = 0;

  for (let i = 0; i < 20; i++) {
    await humanScroll(page, 600);
    await sleep(800 + Math.random() * 600);

    const newHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (newHeight === prevHeight) {
      unchangedPasses++;
      if (unchangedPasses >= 3) break; // page fully loaded
    } else {
      unchangedPasses = 0;
    }
    prevHeight = newHeight;
  }

  // Scroll back to top so we can scan from beginning
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
}

async function sumReviewCounts(page, profileUrl) {
  return await page.evaluate(() => {
    // Strategy 1: Target the "About Host" statistics container cards directly
    const statCards = document.querySelectorAll('div[data-testid="user-profile-card-biography"] div, div[data-component-type="user_profile_card"] div');
    for (const card of statCards) {
      const text = card.innerText || '';
      // Look for a standalone number followed immediately by "Reviews" or "reviews"
      const match = text.match(/^(\d+)\s*\n?\s*Reviews/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Strategy 2: Fallback to scanning the entire document text near structural headers
    const pageText = document.body.innerText || '';
    const globalMatch = pageText.match(/(\d+)\s+Reviews\b/i) || pageText.match(/About\s+[^]+?(\d+)\s+Reviews/i);
    if (globalMatch) {
      return parseInt(globalMatch[1], 10);
    }

    return null;
  });
}

    // ── Strategy 1: Listing card selectors ────────────────────────────────────
    const cardSelectors = [
      '[data-testid="listing-card-title"]',
      '[data-testid="card-container"]',
      '[class*="listingCard"]',
      '[class*="ListingCard"]',
      '[class*="StayCard"]',
      'div[itemprop="itemListElement"]',
    ];

    const counts = [];

    for (const sel of cardSelectors) {
      const cards = document.querySelectorAll(sel);
      if (cards.length === 0) continue;

      for (const card of cards) {
        const text = card.textContent || '';
        // Look for rating+count pattern: "4.85 (312)" or "4.85 · 312 reviews"
        const c = extractCount(text);
        if (c !== null) counts.push(c);
      }
      if (counts.length > 0) break;
    }

    if (counts.length > 0) {
      return counts.reduce((a, b) => a + b, 0);
    }

    // ── Strategy 2: Scan all aria-labels for review counts ────────────────────
    const ariaEls = document.querySelectorAll('[aria-label*="review"]');
    for (const el of ariaEls) {
      const label = el.getAttribute('aria-label') || '';
      const c = extractCount(label);
      if (c !== null) counts.push(c);
    }

    if (counts.length > 0) {
      return counts.reduce((a, b) => a + b, 0);
    }

    // ── Strategy 3: Full page text scan for review counts near star ratings ───
    // Collect all leaf-node texts; look for a number immediately after a rating
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let lastWasRating = false;

    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (!t) continue;

      // Rating pattern: "4.85" or "4.9"
      if (/^[45]\.\d{1,2}$/.test(t)) {
        lastWasRating = true;
        continue;
      }

      if (lastWasRating) {
        const c = extractCount(t);
        if (c !== null) counts.push(c);
        lastWasRating = false;
      } else {
        lastWasRating = false;
      }
    }

    return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
  }, profileUrl);
}

async function dismissOverlays(page) {
  const selectors = [
    'button[aria-label="Close"]',
    'button[data-testid="modal-close-btn"]',
    'button[data-testid="close-button"]',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    '[id*="cookie"] button',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        await el.click().catch(() => null);
        await sleep(700);
        return;
      }
    }
  }
}

module.exports = { scrapeAirbnb };
