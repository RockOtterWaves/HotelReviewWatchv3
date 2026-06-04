/**
 * Booking.com Review Scraper
 *
 * Paginates through reviews sorted newest-first.
 * Counts reviews matching the target month/year by parsing
 * "Reviewed: Month DD, YYYY" date labels on each card.
 *
 * Stops when 3+ consecutive old reviews appear (threshold guards
 * against a single bumped/edited review killing the scrape early).
 */

const { createStealthPage, humanScroll, sleep } = require('../browser');

async function scrapeBooking(browser, url, targetMonth) {
  const { page, context } = await createStealthPage(browser);

  try {
    const reviewUrl = buildReviewUrl(url);
    console.log(`    → ${reviewUrl}`);

    await page.goto(reviewUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500 + Math.random() * 2000);

    await dismissCookies(page);
    await sleep(800);

    // Sort by newest before paginating
    await sortByNewest(page);
    await sleep(1500 + Math.random() * 1000);

    let totalCount = 0;
    let pageNum = 1;
    // FIX: use a consecutive-old threshold instead of stopping on first old review
    let consecutiveOldPages = 0;
    const MAX_OLD_PAGES = 2;

    while (true) {
      console.log(`    📄  Page ${pageNum}`);

      // Wait for reviews to render
      const loaded = await page.waitForSelector(
        '[data-testid="review-card"], .review_item, .c-review-block, [class*="reviewListItem"]',
        { timeout: 12000 }
      ).catch(() => null);

      if (!loaded) {
        console.log(`    ⚠️  No review elements found on page ${pageNum} — stopping`);
        break;
      }

      await sleep(1000 + Math.random() * 800);

      const { count, allOlder } = await extractBookingReviews(page, targetMonth);
      totalCount += count;
      console.log(`    ✅  Page ${pageNum}: ${count} matching reviews`);

      if (allOlder) {
        consecutiveOldPages++;
        if (consecutiveOldPages >= MAX_OLD_PAGES) {
          console.log(`    ⏹️  ${MAX_OLD_PAGES} consecutive pages with no target-month reviews — done`);
          break;
        }
      } else {
        consecutiveOldPages = 0;
      }

      // Look for next page button
      const nextButton = await page.$(
        'button[aria-label="Next page"]:not([disabled]), ' +
        'a[aria-label="Next page"], ' +
        '.bui-pagination__next-arrow:not([disabled]), ' +
        '[data-testid="pagination-next"]:not([disabled])'
      ).catch(() => null);

      if (!nextButton) {
        console.log(`    ⏹️  No next-page button — end of reviews`);
        break;
      }

      await humanScroll(page, 300);
      await sleep(600 + Math.random() * 600);
      await nextButton.click();
      await sleep(2500 + Math.random() * 1500);
      pageNum++;

      if (pageNum > 60) {
        console.log(`    ⏹️  Safety limit reached (60 pages)`);
        break;
      }
    }

    return totalCount;

  } finally {
    await context.close();
  }
}

// FIX: was double-collecting — structured selectors ran in addition to the
// querySelectorAll('*') scan, so the same date text was pushed twice.
// Now uses a single deduped Set keyed by element reference.
async function extractBookingReviews(page, targetMonth) {
  return await page.evaluate((target) => {
    const monthNames = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December',
    ];

    // Collect all leaf-node texts that mention "Reviewed:" OR look like dates
    // Use a WeakSet-equivalent via index to avoid double-counting same element
    const seenEls = new Set();
    const dateCandidates = [];

    // Primary: elements explicitly containing "Reviewed:"
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (t.includes('Reviewed:') && !seenEls.has(el)) {
          seenEls.add(el);
          dateCandidates.push(t);
        }
      }
    }

    // Secondary: structured selectors (only if primary yielded nothing)
    if (dateCandidates.length === 0) {
      const structured = [
        '[data-testid="review-date"]',
        '.c-review-block__date',
        '.review_item_date',
        '[class*="reviewDate"]',
        '[class*="review-date"]',
      ];
      for (const sel of structured) {
        document.querySelectorAll(sel).forEach(el => {
          if (!seenEls.has(el)) {
            seenEls.add(el);
            const t = el.textContent.trim();
            if (t) dateCandidates.push(t);
          }
        });
      }
    }

    const patterns = [
      /Reviewed:\s*(\w+)\s+\d+,?\s*(\d{4})/i,
      /(\w+)\s+\d+,?\s+(\d{4})/,
      /\d+\s+(\w+)\s+(\d{4})/,
    ];

    let count = 0;
    let allOlder = dateCandidates.length > 0; // assume older until proven otherwise

    for (const text of dateCandidates) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const monthStr = match[1];
        const year = parseInt(match[2]);
        const monthIdx = monthNames.findIndex(m =>
          m.toLowerCase().startsWith(monthStr.toLowerCase().substring(0, 3))
        );
        if (monthIdx === -1) continue;

        const reviewMonth = monthIdx + 1;

        if (year === target.year && reviewMonth === target.month) {
          count++;
          allOlder = false; // found at least one in-range review
        } else if (year > target.year || (year === target.year && reviewMonth > target.month)) {
          // Newer than target — shouldn't happen if sorted newest-first but don't break
          allOlder = false;
        }
        // If older: leave allOlder as-is (true unless something newer found)
        break;
      }
    }

    return { count, allOlder };
  }, { year: targetMonth.year, month: targetMonth.month });
}

async function sortByNewest(page) {
  // Booking.com review sort — try several selector patterns
  const sortSelectors = [
    'select[data-testid="reviews-sort"]',
    'select[name*="sort"]',
    'select[id*="sort"]',
    '[data-testid="review-sorting"]',
  ];

  for (const sel of sortSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.selectOption({ label: 'Newest first' }).catch(async () => {
        await el.selectOption({ value: 'f_recent_desc' }).catch(async () => {
          // Try first option that looks like "newest"
          const opts = await el.$$('option');
          for (const opt of opts) {
            const txt = await opt.textContent();
            if (/newest|recent/i.test(txt)) {
              const val = await opt.getAttribute('value');
              await el.selectOption({ value: val }).catch(() => null);
              break;
            }
          }
        });
      });
      await sleep(1500);
      return;
    }
  }
  // If no sort control found, Booking usually defaults to newest — acceptable
}

function buildReviewUrl(url) {
  try {
    const u = new URL(url);
    if (!u.pathname.includes('reviews') && !u.hash.includes('reviews')) {
      u.hash = 'tab-reviews';
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function dismissCookies(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '[data-testid="accept-all-cookies"]',
    'button[id*="accept"]',
    'button[class*="cookie-accept"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.click().catch(() => null);
      await sleep(1000);
      return; // FIX: return after first click, not continue to next selector
    }
  }
}

module.exports = { scrapeBooking };
