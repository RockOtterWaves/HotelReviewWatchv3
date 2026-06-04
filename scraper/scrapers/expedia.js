/**
 * Expedia Review Scraper
 *
 * Sorts by Most Recent, expands the review list, counts by "Month YYYY" text match.
 */

const { createStealthPage, humanScroll, sleep } = require('../browser');

async function scrapeExpedia(browser, url, targetMonth) {
  const { page, context } = await createStealthPage(browser);

  try {
    console.log(`    → ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000 + Math.random() * 2000);

    // FIX: dismiss ONLY the first matching overlay, not all of them
    await dismissFirstOverlay(page);

    await scrollToReviews(page);
    await sortByNewest(page);
    await sleep(2000 + Math.random() * 1000);

    const expandedCount = await expandReviews(page, targetMonth);
    console.log(`    📖  ~${expandedCount} reviews visible`);

    const count = await countExpediaReviews(page, targetMonth);
    return count;

  } finally {
    await context.close();
  }
}

async function scrollToReviews(page) {
  for (let i = 0; i < 6; i++) {
    await humanScroll(page, 500);
    await sleep(350 + Math.random() * 300);
  }

  // Click Reviews tab if present
  const tabSelectors = [
    '[data-stid="reviews-tab"]',
    'button[aria-label*="Review"]',
    'a[href*="#reviews"]',
    'li[data-tab="reviews"]',
    'button:text("Reviews")',
  ];
  for (const sel of tabSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => null);
      await sleep(1500);
      break;
    }
  }
}

async function sortByNewest(page) {
  const sortSelectors = [
    'select[data-testid="reviews-sort"]',
    '[data-testid="reviews-sort-select"]',
    'select[aria-label*="Sort"]',
    'select[aria-label*="sort"]',
  ];

  for (const sel of sortSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;

    const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => null);

    if (tag === 'select') {
      // Try multiple option labels/values for "newest"
      const tried = await el.selectOption({ label: 'Most Recent' }).catch(() => null)
        || await el.selectOption({ label: 'Newest' }).catch(() => null)
        || await el.selectOption({ value: 'newest' }).catch(() => null)
        || await el.selectOption({ value: 'recent' }).catch(() => null);

      if (!tried) {
        // Enumerate options and pick the newest-sounding one
        const options = await el.$$('option').catch(() => []);
        for (const opt of options) {
          const txt = (await opt.textContent().catch(() => '')).trim();
          if (/newest|recent|latest/i.test(txt)) {
            const val = await opt.getAttribute('value');
            await el.selectOption({ value: val }).catch(() => null);
            break;
          }
        }
      }
      await sleep(2000);
      return;
    }

    // Button-style sort control
    await el.click().catch(() => null);
    await sleep(600);

    // FIX: was using invalid CSS selector syntax for text matching
    // Use Playwright's :text() pseudo-class properly
    const newestOption = await page.$(':text("Most Recent")').catch(() => null)
      || await page.$(':text("Newest")').catch(() => null)
      || await page.$('[data-value="newest"]').catch(() => null);

    if (newestOption) {
      await newestOption.click().catch(() => null);
      await sleep(2000);
    }
    return;
  }

  // Fallback: try a button with sort-related text
  const sortBtn = await page.$('button:has-text("Sort"), button:has-text("Most relevant")').catch(() => null);
  if (sortBtn) {
    await sortBtn.click().catch(() => null);
    await sleep(600);
    const newestOpt = await page.$(':text("Most Recent"), :text("Newest")').catch(() => null);
    if (newestOpt) await newestOpt.click().catch(() => null);
    await sleep(2000);
  }
}

async function expandReviews(page, targetMonth) {
  const maxClicks = 35;
  let clicks = 0;

  while (clicks < maxClicks) {
    // Check if we've loaded far enough back (2 months before target = safe cutoff)
    const reachedCutoff = await page.evaluate((target) => {
      const monthNames = [
        'January','February','March','April','May','June',
        'July','August','September','October','November','December',
      ];
      const cutoff = new Date(target.year, target.month - 3, 1);
      const cutoffStr = `${monthNames[cutoff.getMonth()]} ${cutoff.getFullYear()}`;
      return document.body.innerText.includes(cutoffStr);
    }, { year: targetMonth.year, month: targetMonth.month }).catch(() => false);

    if (reachedCutoff) break;

    const loadMoreSelectors = [
      'button[data-testid="load-more-reviews"]',
      'button[aria-label*="more review"]',
      'button[class*="loadMore"]',
      'button:text("Show more reviews")',
      'button:text("Load more")',
      'button:text("See more reviews")',
      'button:text("Show more")',
    ];

    let clicked = false;
    for (const sel of loadMoreSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        const isVisible = await btn.isVisible().catch(() => false);
        if (!isVisible) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => null);
        await sleep(400 + Math.random() * 300);
        await btn.click().catch(() => null);
        await sleep(2200 + Math.random() * 1000);
        clicks++;
        clicked = true;
        break;
      }
    }

    if (!clicked) break;
    await humanScroll(page, 400);
  }

  // Return count of review elements visible
  return await page.evaluate(() => {
    for (const sel of [
      '[data-testid="review-card"]',
      '.uitk-card[data-testid*="review"]',
      '[class*="ReviewCard"]',
      '.review-container',
    ]) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return els.length;
    }
    return 0;
  }).catch(() => 0);
}

async function countExpediaReviews(page, targetMonth) {
  return await page.evaluate((tgt) => {
    // Map numerical month to Expedia's text format
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const targetString = `${months[tgt.month - 1]} ${tgt.year}`; // e.g., "May 2026"
    
    console.log(`Searching for string matches of: ${targetString}`);

    // Replicate structural fallback check
    let totalFound = 0;
    const reviewCards = document.querySelectorAll('[data-stid="review-card"], .uitk-card, article');
    
    if (reviewCards.length > 0) {
      reviewCards.forEach(card => {
        if (card.innerText && card.innerText.includes(targetString)) {
          totalFound++;
        }
      });
    }

    // Absolute fallback: If container bindings failed, run a raw regex match on the text stream
    if (totalFound === 0) {
      const cleanBodyText = document.body.innerText || '';
      // Escapes string characters safely to prevent structural crashes
      const escapedStr = targetString.replace(/[.*+?^${}()|[\\]\\\]/g, '\\$&');
      const matches = cleanBodyText.match(new RegExp(`\\b${escapedStr}\\b`, 'g'));
      return matches ? matches.length : 0;
    }

    return totalFound;
  }, { month: targetMonth.month, year: targetMonth.year });
}


// FIX: was iterating ALL selectors and clicking each — now exits after first match
async function dismissFirstOverlay(page) {
  const overlaySelectors = [
    'button[data-testid="dialog-close"]',
    'button[aria-label="Close"]',
    '.uitk-dialog-close',
    '#cookie-consent-accept',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
  ];

  for (const sel of overlaySelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const isVisible = await el.isVisible().catch(() => false);
      if (isVisible) {
        await el.click().catch(() => null);
        await sleep(900);
        return; // done — only click the first visible overlay
      }
    }
  }
}

module.exports = { scrapeExpedia };
