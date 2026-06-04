/**
 * Stealth browser factory
 * playwright-extra + puppeteer-extra-plugin-stealth
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// FIX: was creating browser with no user-agent/viewport applied at browser level;
// 'headless: true' is deprecated in newer Playwright — use 'new'
async function createStealthBrowser() {
  const browser = await chromium.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--lang=en-US,en',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return browser;
}

async function createStealthPage(browser) {
  const userAgent = randomItem(USER_AGENTS);
  const viewport = randomItem(VIEWPORTS);

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    permissions: ['geolocation'],
    geolocation: { latitude: 34.0522, longitude: -118.2437 },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
  });

  // Set a default navigation timeout so hung pages don't block forever
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(15000);

  return { page, context };
}

async function humanMove(page, x, y) {
  const steps = 10 + Math.floor(Math.random() * 15);
  await page.mouse.move(x, y, { steps });
}

// FIX: sleep was called before being exported; moved to top of file
async function humanScroll(page, distance = 300) {
  const scrollAmount = distance + Math.floor(Math.random() * 200 - 100);
  await page.evaluate((amount) => {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }, scrollAmount);
  await sleep(300 + Math.random() * 500);
}

module.exports = { createStealthBrowser, createStealthPage, humanMove, humanScroll, sleep };
