/**
 * Google Business Profile Review Scraper
 *
 * Sorts by Newest, scrolls the side panel, counts reviews
 * whose relative/absolute date falls within the target month.
 *
 * Date logic (running on the 7th):
 *   "X days ago"   → compute exact date, check if in target month
 *   "X weeks ago"  → compute exact date, check if in target month
 *   "a month ago"  → per user rule: STOP / exclude
 *   "2+ months ago"→ STOP
 *   "May 12, 2026" → parse directly
 *
 * FIX: de-duplication now uses a stable element identity key
 * (data-review-id attribute or an ordinal index), not offsetTop
 * which changes as the panel scrolls and caused double-counting.
 */

const { createStealthPage, humanScroll, sleep } = require('../browser');

async function scrapeGoogle(browser, url, targetMonth) {
  const { page, context } = await createStealthPage(browser);

  try {
    console.log(`    → ${url}`);

    // Ensure we land on the reviews panel directly if possible
    const targetUrl = buildReviewsUrl(url);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500 + Math.random() * 2000);

    await dismissCookies(page);
    await sleep(600);

    // FIX: wait for Maps to fully render before clicking tabs
    await page.waitForSelector('div[role="main"], div[jsrenderer]', { timeout: 10000 }).catch(() => null);
    await sleep(1000 + Math.random() * 800);

    await openReviewsPanel(page);
    await sleep(2000 + Math.random() * 1000);

    await sortByNewest(page);
    await sleep(2500 + Math.random() * 1000);

    const count = await scrollAndCount(page, targetMonth);
    return count;

  } finally {
    await context.close();
  }
}

function buildReviewsUrl(url) {
  // If the URL doesn't already point at reviews, append /reviews
  try {
    const u = new URL(url);
    if (!u.pathname.includes('/reviews')) {
      // Google Maps URLs end with a place ID like /place/Name/@lat,lng,zoom
      // Adding ?hl=en ensures English date strings
      u.searchParams.set('hl', 'en');
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function openReviewsPanel(page) {
  const reviewButtonSelectors = [
    'button[aria-label*="Reviews"]',
    'button[aria-label*="review"]',
    '[data-tab-index="1"]',
    'button:has-text("Reviews")',
    '[aria-label="Reviews"]',
    '[jsaction*="pane.rating.moreReviews"]',
  ];

  for (const sel of reviewButtonSelectors) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    const visible = await btn.isVisible().catch(() => false);
    if (visible) {
      await btn.click().catch(() => null);
      await sleep(2000);
      return;
    }
  }
  // Already on reviews panel (direct URL) — that's fine
}

async function sortByNewest(page) {
  // Google Maps: click the sort button (usually labelled "Most relevant" by default)
  const sortTriggerSelectors = [
    'button[aria-label="Sort reviews"]',
    'button[aria-haspopup="menu"][aria-label*="Sort"]',
    '[jsaction*="sortReviews"]',
    'button[data-value="Sort"]',
    'button:has-text("Most relevant")',
    'button:has-text("Sort")',
  ];

  let opened = false;
  for (const sel of sortTriggerSelectors) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    const visible = await btn.isVisible().catch(() => false);
    if (visible) {
      await btn.click().catch(() => null);
      await sleep(1200 + Math.random() * 500);
      opened = true;
      break;
    }
  }

  if (!opened) {
    console.log(`    ⚠️  Could not open Google sort menu — using default order`);
    return;
  }

  // Now click "Newest" in the dropdown
  const newestSelectors = [
    'li[data-index="1"]',
    'li:has-text("Newest")',
    'div[role="menuitem"]:has-text("Newest")',
    'li[role="menuitem"]:has-text("Newest")',
    '[aria-label="Newest"]',
    'button:has-text("Newest")',
  ];

  for (const sel of newestSelectors) {
    const opt = await page.$(sel).catch(() => null);
    if (!opt) continue;
    const visible = await opt.isVisible().catch(() => false);
    if (visible) {
      await opt.click().catch(() => null);
      await sleep(2200 + Math.random() * 1000);
      return;
    }
  }

  console.log(`    ⚠️  Could not select Newest — reviews may not be in date order`);
  // Press Escape to close the menu if it's still open
  await page.keyboard.press('Escape').catch(() => null);
}

async function scrollAndCount(page, targetMonth) {
  const runDate = new Date();
  const targetStart = new Date(targetMonth.year, targetMonth.month - 1, 1);
  const targetEnd   = new Date(targetMonth.year, targetMonth.month, 0, 23, 59, 59);

  // FIX: find the scrollable panel ONCE before the loop and cache its selector
  const panelSel = await findScrollPanel(page);

  // FIX: use a stable Set of element indices rather than offsetTop-based keys
  // We reset this once, then pass it between evaluate calls via window._seenReviewIds
  await page.evaluate(() => { window._seenReviewIds = new Set(); });

  let totalCount = 0;
  let shouldStop = false;
  let scrollAttempts = 0;
  const maxScrolls = 80;

  while (!shouldStop && scrollAttempts < maxScrolls) {
    const { newCount, stop, reachedEnd } = await page.evaluate((params) => {
      const { runDateISO, targetStartISO, targetEndISO } = params;
      const runDate     = new Date(runDateISO);
      const targetStart = new Date(targetStartISO);
      const targetEnd   = new Date(targetEndISO);

      const seen = window._seenReviewIds;  // persists across evaluate calls
      let counted = 0;
      let stop = false;

      // Google encodes dates as relative strings on span elements that are
      // direct children of the review block. We find them via multiple selectors.
      const dateContainerSelectors = [
        '[data-review-id]',          // each review card has this attr
        '[class*="jftiEf"]',          // Maps review block class (current as of mid-2024)
        '[class*="GHT2ce"]',          // alternative Maps review class
        'div[jslog*="impression"]',   // impression-tracked review divs
      ];

      let reviewEls = [];
      for (const sel of dateContainerSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length > 0) { reviewEls = els; break; }
      }

      // If no structural containers found, fall back to broad span scan
      if (reviewEls.length === 0) {
        // Broad fallback — find spans that look like date strings
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          if (span.children.length > 0) continue;
          const t = span.textContent.trim();
          if (!t) continue;

          // Must look like a date string
          const isDateLike = (
            /^\d+\s+(day|week|month|year)s?\s+ago$/i.test(t) ||
            /^a\s+(month|year)\s+ago$/i.test(t) ||
            /^[A-Za-z]+\s+\d+,?\s+\d{4}$/.test(t)
          );
          if (!isDateLike) continue;

          // Use parent index as stable ID
          const idx = Array.from(span.parentElement?.children || []).indexOf(span);
          const stableKey = `${t}__${idx}__${span.parentElement?.className}`;
          if (seen.has(stableKey)) continue;

          const result = parseDateText(t, runDate, targetStart, targetEnd);
          if (result === 'stop') { stop = true; break; }
          if (result === 'match') { seen.add(stableKey); counted++; }
          if (result === 'older') { stop = true; break; }
        }
        const reachedEnd = document.querySelectorAll('[class*="section-loading-spinner"]').length === 0
          && document.querySelectorAll('[data-review-id]').length === 0;
        return { newCount: counted, stop, reachedEnd: false };
      }

      // Structured path: iterate review cards, extract their date span
      for (const card of reviewEls) {
        const reviewId = card.getAttribute('data-review-id') || card.getAttribute('jslog') || '';
        // Use the card's position in DOM as fallback stable ID
        const cardIdx = Array.from(card.parentElement?.children || []).indexOf(card);
        const stableId = reviewId || `card-${cardIdx}-${card.className.substring(0, 20)}`;

        if (seen.has(stableId)) continue; // already processed this review

        // Find the date span within this card — look for the relative-date text
        const allSpans = card.querySelectorAll('span');
        let dateText = null;
        for (const span of allSpans) {
          if (span.children.length > 0) continue;
          const t = span.textContent.trim();
          if (/^\d+\s+(day|week|month|year)s?\s+ago$/i.test(t) ||
              /^a\s+(month|year)\s+ago$/i.test(t) ||
              /^[A-Za-z]+\s+\d+,?\s+\d{4}$/.test(t)) {
            dateText = t;
            break;
          }
        }

        if (!dateText) continue; // card doesn't have a parseable date yet (not scrolled into view)

        const result = parseDateText(dateText, runDate, targetStart, targetEnd);
        if (result === 'stop') { stop = true; break; }
        if (result === 'match') { seen.add(stableId); counted++; }
        if (result === 'older') { stop = true; break; }
        // 'skip' or 'newer' — mark seen so we don't re-process
        seen.add(stableId);
      }

      window._seenReviewIds = seen;
      return { newCount: counted, stop, reachedEnd: false };

      // ── Date parser (inline, runs in browser context) ────────────────────────
      function parseDateText(text, runDate, targetStart, targetEnd) {
        const daysM  = text.match(/^(\d+)\s+days?\s+ago$/i);
        const weeksM = text.match(/^(\d+)\s+weeks?\s+ago$/i);
        const monthM = text.match(/^a\s+month\s+ago$/i);
        const monthsM= text.match(/^(\d+)\s+months?\s+ago$/i);
        const yearM  = text.match(/^a?\s*year/i);
        const absM   = text.match(/^([A-Za-z]+)\s+(\d+),?\s+(\d{4})$/);

        if (monthM || monthsM || yearM) return 'stop';

        let reviewDate = null;
        if (daysM) {
          reviewDate = new Date(runDate);
          reviewDate.setDate(reviewDate.getDate() - parseInt(daysM[1]));
        } else if (weeksM) {
          reviewDate = new Date(runDate);
          reviewDate.setDate(reviewDate.getDate() - parseInt(weeksM[1]) * 7);
        } else if (absM) {
          const months = ['january','february','march','april','may','june',
                          'july','august','september','october','november','december'];
          const mIdx = months.findIndex(m => m.startsWith(absM[1].toLowerCase().substring(0,3)));
          if (mIdx !== -1) reviewDate = new Date(parseInt(absM[3]), mIdx, parseInt(absM[2]));
        }

        if (!reviewDate) return 'skip';
        if (reviewDate >= targetStart && reviewDate <= targetEnd) return 'match';
        if (reviewDate < targetStart) return 'older';
        return 'newer'; // future date — skip
      }
    }, {
      runDateISO:     runDate.toISOString(),
      targetStartISO: targetStart.toISOString(),
      targetEndISO:   targetEnd.toISOString(),
    });

    totalCount += newCount;
    if (stop || reachedEnd) { shouldStop = true; break; }

    // Scroll the panel
    if (panelSel) {
      const scrolled = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const before = el.scrollTop;
        el.scrollTop += 700;
        return el.scrollTop !== before; // false = hit the bottom
      }, panelSel).catch(() => false);

      if (!scrolled) { shouldStop = true; break; } // reached bottom
    } else {
      await humanScroll(page, 700);
    }

    await sleep(1800 + Math.random() * 1000);
    scrollAttempts++;
  }

  return totalCount;
}

async function findScrollPanel(page) {
  return await page.evaluate(() => {
    const candidates = [
      'div[aria-label*="Reviews for"]',
      'div.m6QErb.D37wXb', 
      'div.m6QErb[tabindex="0"]',
      'div[role="main"] div[tabindex="-1"]',
      '#QA0Szd div[tabindex="0"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 30) return sel;
    }
    return null;
  }).catch(() => null);
}

async function dismissCookies(page) {
  const selectors = [
    '#L2AGLb',                           // Google's standard "Accept all" ID
    'button[aria-label*="Accept all"]',
    'button:has-text("Accept all")',
    'div[aria-modal="true"] button:first-child',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) {
        await btn.click().catch(() => null);
        await sleep(900);
        return;
      }
    }
  }
}

module.exports = { scrapeGoogle };
