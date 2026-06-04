#!/usr/bin/env node
/**
 * Property URL Auto-Finder
 *
 * Usage:
 *   node search-property.js
 *   → Interactive prompt: enter hotel name + address
 *   → Searches Booking.com, Expedia, Google Maps
 *   → Outputs a ready-to-paste properties.json entry
 *   → Optionally appends to properties.json automatically
 *
 * Airbnb profile URLs must still be added manually (no search API).
 *
 * Requires: node 18+ (uses built-in fetch for Google search)
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { createStealthBrowser, createStealthPage, sleep } = require('./browser');

const PROPERTIES_PATH = path.join(__dirname, '..', 'properties.json');

// ─── CLI helpers ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── URL finders ──────────────────────────────────────────────────────────────

async function findBookingUrl(browser, name, address) {
  const { page, context } = await createStealthPage(browser);
  try {
    const query = encodeURIComponent(`${name} ${address} site:booking.com/hotel`);
    await page.goto(`https://www.google.com/search?q=${query}&hl=en`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await sleep(1500 + Math.random() * 1000);

    // Extract first booking.com/hotel link from results
    const url = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        const href = a.href || '';
        if (href.includes('booking.com/hotel/')) {
          // Strip Google redirect wrapper
          try { return new URL(href).searchParams.get('q') || href; } catch { return href; }
        }
      }
      // Check cite elements too (Google shows actual URLs there)
      const cites = document.querySelectorAll('cite');
      for (const c of cites) {
        const t = c.textContent.trim();
        if (t.includes('booking.com/hotel')) {
          return 'https://' + t.replace(/^https?:\/\//, '');
        }
      }
      return null;
    });

    if (url) return cleanUrl(url);

    // Fallback: search directly on booking.com
    return await searchOnBooking(page, name, address);
  } catch (e) {
    console.log(`    ⚠️  Booking.com search error: ${e.message}`);
    return null;
  } finally {
    await context.close();
  }
}

async function searchOnBooking(page, name, address) {
  const q = encodeURIComponent(`${name} ${address}`);
  await page.goto(`https://www.booking.com/search.html?ss=${q}`, {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await sleep(2000);

  return await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/hotel/"]');
    if (links.length > 0) return links[0].href;
    return null;
  });
}

async function findExpediaUrl(browser, name, address) {
  const { page, context } = await createStealthPage(browser);
  try {
    const query = encodeURIComponent(`${name} ${address} site:expedia.com`);
    await page.goto(`https://www.google.com/search?q=${query}&hl=en`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await sleep(1500 + Math.random() * 1000);

    const url = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        const href = a.href || '';
        if (href.includes('expedia.com') && (href.includes('-Hotels-') || href.includes('/Hotel-'))) {
          try { return new URL(href).searchParams.get('q') || href; } catch { return href; }
        }
      }
      const cites = document.querySelectorAll('cite');
      for (const c of cites) {
        const t = c.textContent.trim();
        if (t.includes('expedia.com') && (t.includes('Hotels') || t.includes('Hotel'))) {
          return 'https://' + t.replace(/^https?:\/\//, '').split(' ')[0];
        }
      }
      return null;
    });

    return url ? cleanUrl(url) : null;
  } catch (e) {
    console.log(`    ⚠️  Expedia search error: ${e.message}`);
    return null;
  } finally {
    await context.close();
  }
}

async function findGoogleMapsUrl(browser, name, address) {
  const { page, context } = await createStealthPage(browser);
  try {
    const query = encodeURIComponent(`${name} ${address}`);
    await page.goto(`https://www.google.com/maps/search/${query}`, {
      waitUntil: 'domcontentloaded', timeout: 25000,
    });
    await sleep(3000 + Math.random() * 1500);

    // Google Maps redirects to the place URL — capture it
    const finalUrl = page.url();

    // Wait for a /place/ URL to appear (Maps redirects there for specific matches)
    if (!finalUrl.includes('/place/')) {
      // Try clicking the first result
      const firstResult = await page.$('[class*="result"], div[role="article"] a, .hfpxzc').catch(() => null);
      if (firstResult) {
        await firstResult.click().catch(() => null);
        await sleep(2500);
        const redirected = page.url();
        if (redirected.includes('/place/')) return cleanGoogleUrl(redirected);
      }
    }

    return finalUrl.includes('/place/') ? cleanGoogleUrl(finalUrl) : null;
  } catch (e) {
    console.log(`    ⚠️  Google Maps search error: ${e.message}`);
    return null;
  } finally {
    await context.close();
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Remove tracking/session params
    ['sid','aid','label','source','from','clicked','ucfs','activeTab'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

function cleanGoogleUrl(url) {
  try {
    const u = new URL(url);
    // Keep only the path + minimal params — strip sensitive tracking
    return `https://www.google.com${u.pathname}`;
  } catch {
    return url;
  }
}

// ─── Properties file management ───────────────────────────────────────────────

function loadProperties() {
  if (!fs.existsSync(PROPERTIES_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PROPERTIES_PATH, 'utf8')); }
  catch { return []; }
}

function saveProperties(props) {
  fs.writeFileSync(PROPERTIES_PATH, JSON.stringify(props, null, 2));
}

// ─── Main interactive flow ────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍  Property URL Auto-Finder');
  console.log('════════════════════════════════════════\n');
  console.log('This tool searches Booking.com, Expedia, and Google Maps');
  console.log('for a property by name and address.\n');
  console.log('Airbnb profile URLs must be added manually.\n');

  const browser = await createStealthBrowser();
  const properties = loadProperties();

  try {
    while (true) {
      const name    = (await ask('Hotel name (or blank to quit): ')).trim();
      if (!name) break;

      const address = (await ask('Address / city (e.g. "Morro Bay, CA"): ')).trim();
      if (!address) break;

      console.log(`\n  Searching for: "${name}" in "${address}"\n`);

      // Check for existing entry
      const existingIdx = properties.findIndex(p =>
        p.name.toLowerCase() === name.toLowerCase()
      );

      let existing = existingIdx !== -1 ? properties[existingIdx] : null;

      console.log('  🔍  Booking.com...');
      const bookingUrl = existing?.bookingUrl || await findBookingUrl(browser, name, address);
      console.log(`      ${bookingUrl || '(not found)'}`);
      await sleep(3000 + Math.random() * 2000);

      console.log('  🔍  Expedia...');
      const expediaUrl = existing?.expediaUrl || await findExpediaUrl(browser, name, address);
      console.log(`      ${expediaUrl || '(not found)'}`);
      await sleep(3000 + Math.random() * 2000);

      console.log('  🔍  Google Maps...');
      const googleUrl = existing?.googleUrl || await findGoogleMapsUrl(browser, name, address);
      console.log(`      ${googleUrl || '(not found)'}`);

      console.log('\n  ─────────────────────────────────────');
      const airbnbUrl = existing?.airbnbUrl || '';
      if (!airbnbUrl) {
        console.log('  ℹ️   Airbnb: not set — add manually after (format: https://www.airbnb.com/users/show/XXXXXXX)');
      } else {
        console.log(`  ✅  Airbnb (existing): ${airbnbUrl}`);
      }

      const entry = {
        id:         slugify(name),
        name,
        bookingUrl: bookingUrl || null,
        expediaUrl: expediaUrl || null,
        airbnbUrl:  airbnbUrl || null,
        googleUrl:  googleUrl || null,
      };

      console.log('\n  📋  Generated entry:');
      console.log(JSON.stringify(entry, null, 4));

      const save = (await ask('\n  Save to properties.json? (y/n): ')).trim().toLowerCase();
      if (save === 'y' || save === 'yes') {
        if (existingIdx !== -1) {
          properties[existingIdx] = entry;
          console.log(`  ✅  Updated existing entry for "${name}"`);
        } else {
          properties.push(entry);
          console.log(`  ✅  Added "${name}" to properties.json`);
        }
        saveProperties(properties);
      }

      console.log('\n  ─────────────────────────────────────\n');
      const another = (await ask('  Add another property? (y/n): ')).trim().toLowerCase();
      if (another !== 'y' && another !== 'yes') break;
      console.log('');
    }
  } finally {
    await browser.close();
    rl.close();
  }

  console.log('\n✅  Done. Edit properties.json to add/update Airbnb URLs.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  rl.close();
  process.exit(1);
});
