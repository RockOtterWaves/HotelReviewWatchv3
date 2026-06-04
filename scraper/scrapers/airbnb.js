/**
 * Airbnb Host Profile Scraper
 *
 * Scrapes the host's profile page (airbnb.com/users/show/ID or
 * airbnb.com/users/profile/ID) rather than individual listings.
 *
 * Strategy:
 * - Load the host profile page
 * - Dynamically extract the master total review count directly from the 
 * "About Host" card as requested to match manual workflow.
 * - Delta vs previous run = new reviews gained (calculated in index.js)
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

    const total = await sumReviewCounts(page, profileUrl);

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
  try {
    const u = new URL(url);
    // Keep only the path — strip query params that might redirect
    return `https://www.airbnb.com${u.pathname}`;
  } catch {
    return url;
  }
}

async function loadAllListings(page) {
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
