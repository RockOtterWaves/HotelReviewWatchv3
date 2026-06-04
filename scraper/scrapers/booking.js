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

// Intelligent extraction: replicates your manual "click and count" workflow
      const { count, allOlder } = await page.evaluate((tgt) => {
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const targetMonthName = monthNames[tgt.month - 1].toLowerCase();
        
        let foundOnPage = 0;
        let strictlyOlder = true;

        // Replicates your manual step: looks for any element containing "Reviewed:" to find the date stamp
        const allElements = document.querySelectorAll('*');
        allElements.forEach(el => {
          if (el.children.length === 0 && el.textContent && el.textContent.includes('Reviewed:')) {
            const text = el.textContent.toLowerCase(); // e.g., "reviewed: may 28, 2026"
            
            // 1. Check if it matches our target month and year
            if (text.includes(targetMonthName) && text.includes(tgt.year.toString())) {
              foundOnPage++;
              strictlyOlder = false;
            } 
            // 2. Check if the review is newer than our target (relevant for your baseline)
            else if (text.includes(tgt.year.toString())) {
               const foundMonthIdx = monthNames.findIndex(m => text.includes(m.toLowerCase()));
               if (foundMonthIdx > (tgt.month - 1)) {
                 strictlyOlder = false; 
               }
            }
          }
        });

        return { count: foundOnPage, allOlder: strictlyOlder };
      }, { month: targetMonth.month, year: targetMonth.year });

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
