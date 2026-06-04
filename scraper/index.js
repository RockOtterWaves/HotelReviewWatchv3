/**
 * Hotel Review Tracker — Main Orchestrator
 *
 * Modes:
 *   node index.js                  — normal monthly run (counts prev month reviews)
 *   node index.js --baseline       — first-time run: captures current Airbnb totals +
 *                                    counts current month reviews on all platforms
 *   node index.js --dry-run        — validates config, no scraping, no data written
 *   node index.js --month 2026-05  — override target month (for reruns/backfills)
 */

const fs   = require('fs');
const path = require('path');
const { scrapeBooking } = require('./scrapers/booking');
const { scrapeExpedia } = require('./scrapers/expedia');
const { scrapeAirbnb }  = require('./scrapers/airbnb');
const { scrapeGoogle }  = require('./scrapers/google');
const { createStealthBrowser, sleep } = require('./browser');

const isDryRun  = process.argv.includes('--dry-run');
const isBaseline = process.argv.includes('--baseline');

// --month 2026-05 override
const monthOverrideIdx = process.argv.indexOf('--month');
const monthOverride = monthOverrideIdx !== -1 ? process.argv[monthOverrideIdx + 1] : null;

// ─── Alerts / structured logging ──────────────────────────────────────────────

const alerts = [];   // collected warnings surfaced at end + written to alerts.json

function warn(propertyName, platform, message) {
  const entry = {
    level: 'warn',
    property: propertyName,
    platform,
    message,
    time: new Date().toISOString(),
  };
  alerts.push(entry);
  console.warn(`  ⚠️  [${platform}] ${message}`);
}

function error(propertyName, platform, message) {
  const entry = {
    level: 'error',
    property: propertyName,
    platform,
    message,
    time: new Date().toISOString(),
  };
  alerts.push(entry);
  console.error(`  ❌  [${platform}] ${message}`);
}

function saveAlerts(runLabel) {
  const alertsPath = path.join(__dirname, '..', 'data', 'alerts.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(alertsPath, 'utf8')); } catch {}
  existing.unshift({ run: runLabel, at: new Date().toISOString(), alerts });
  // Keep only last 10 runs
  existing = existing.slice(0, 10);
  fs.writeFileSync(alertsPath, JSON.stringify(existing, null, 2));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return {
    year: y,
    month: m,
    monthName: d.toLocaleString('en-US', { month: 'long' }),
    label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    key,
  };
}

function getTargetMonth() {
  if (monthOverride) {
    if (!/^\d{4}-\d{2}$/.test(monthOverride)) {
      console.error('❌  --month must be in YYYY-MM format e.g. --month 2026-05');
      process.exit(1);
    }
    return parseMonthKey(monthOverride);
  }

  if (isBaseline) {
    // Baseline captures THIS month's current totals
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return parseMonthKey(key);
  }

  // Normal run: target = previous calendar month
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  return parseMonthKey(key);
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadProperties() {
  const configPath = path.join(__dirname, '..', 'properties.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌  properties.json not found. Copy properties.example.json and add your properties.');
    process.exit(1);
  }
  let props;
  try {
    props = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('❌  properties.json is not valid JSON:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(props) || props.length === 0) {
    console.error('❌  properties.json must be a non-empty array.');
    process.exit(1);
  }
  // Validate each entry has an id and name
  for (const p of props) {
    if (!p.id || !p.name) {
      console.error(`❌  Each property needs an "id" and "name". Missing on: ${JSON.stringify(p)}`);
      process.exit(1);
    }
  }
  return props;
}

// ─── Data persistence ──────────────────────────────────────────────────────────

function loadData() {
  const dataPath = path.join(__dirname, '..', 'data', 'reviews.json');
  if (!fs.existsSync(dataPath)) return { lastUpdated: null, properties: {} };
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (e) {
    console.warn('⚠️  data/reviews.json could not be parsed — starting fresh:', e.message);
    return { lastUpdated: null, properties: {} };
  }
}

function saveData(data) {
  const dataPath = path.join(__dirname, '..', 'data', 'reviews.json');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  // Write to a temp file first then rename — avoids corrupt JSON on crash mid-write
  const tmp = dataPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dataPath);
  console.log(`💾  Saved to data/reviews.json`);
}

// ─── Airbnb delta calculation ─────────────────────────────────────────────────

function calcAirbnbDelta(propertyData, newTotal, targetMonthKey) {
  if (!propertyData || !propertyData.history) {
    return { delta: null, newTotal, note: 'First run — baseline stored. Delta available next month.' };
  }

  const keys = Object.keys(propertyData.history).sort();
  // Find the most recent month BEFORE the target
  const previousKey = keys.filter(k => k < targetMonthKey).pop();

  if (!previousKey) {
    return { delta: null, newTotal, note: 'No prior snapshot found — baseline stored. Delta available next month.' };
  }

  const prevEntry = propertyData.history[previousKey];
  const prevTotal = prevEntry?.platforms?.airbnb?.rawTotal ?? null;

  if (prevTotal === null) {
    return { delta: null, newTotal, note: `Prior entry (${previousKey}) has no rawTotal — cannot diff.` };
  }

  const delta = newTotal - prevTotal;
  if (delta < 0) {
    // Negative delta = review removed or listing change — clamp to 0 but flag it
    return {
      delta: 0,
      newTotal,
      previousTotal: prevTotal,
      previousMonth: previousKey,
      note: `Negative delta detected (${delta}): total dropped from ${prevTotal} to ${newTotal}. Clamped to 0.`,
    };
  }

  return { delta, newTotal, previousTotal: prevTotal, previousMonth: previousKey };
}

// ─── Scrape one property ──────────────────────────────────────────────────────

async function scrapeProperty(browser, property, targetMonth, existingPropertyData) {
  const results = {};

  const scrapers = [
    { key: 'booking', url: property.bookingUrl, fn: scrapeBooking, label: 'Booking.com' },
    { key: 'expedia', url: property.expediaUrl, fn: scrapeExpedia, label: 'Expedia' },
    { key: 'airbnb',  url: property.airbnbUrl,  fn: scrapeAirbnb,  label: 'Airbnb' },
    { key: 'google',  url: property.googleUrl,  fn: scrapeGoogle,  label: 'Google' },
  ];

  for (let i = 0; i < scrapers.length; i++) {
    const scraper = scrapers[i];

    if (!scraper.url) {
      results[scraper.key] = { count: null, error: null, skipped: true, note: 'No URL configured' };
      continue;
    }

    console.log(`  🔍  ${scraper.label}...`);

    // Retry logic — attempt up to 2 times on failure
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await scraper.fn(browser, scraper.url, targetMonth);

        if (scraper.key === 'airbnb') {
          if (raw === null || raw.count === null) {
            throw new Error('Airbnb returned null review count');
          }
          const airbnbResult = calcAirbnbDelta(existingPropertyData, raw.count, targetMonth.key);
          results.airbnb = {
            count: airbnbResult.delta,
            rawTotal: airbnbResult.newTotal,
            previousTotal: airbnbResult.previousTotal ?? null,
            previousMonth: airbnbResult.previousMonth ?? null,
            note: airbnbResult.note || null,
            error: null,
          };
          if (airbnbResult.note) warn(property.name, 'Airbnb', airbnbResult.note);
          console.log(`  ✅  Airbnb: total=${raw.count}, new=${airbnbResult.delta ?? '(baseline)'}`);
        } else {
          if (raw === null || raw === undefined) {
            throw new Error(`${scraper.label} returned null`);
          }
          if (raw === 0) {
            warn(property.name, scraper.label, `Returned 0 reviews — verify URL and page loaded correctly`);
          }
          results[scraper.key] = { count: raw, error: null };
          console.log(`  ✅  ${scraper.label}: ${raw} reviews`);
        }

        lastErr = null;
        break; // success — exit retry loop

      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          console.log(`  ↩️  ${scraper.label} attempt ${attempt} failed — retrying in 15s...`);
          await sleep(15000);
        }
      }
    }

    if (lastErr) {
      results[scraper.key] = { count: null, error: lastErr.message };
      error(property.name, scraper.label, lastErr.message);
    }

    // Human-like delay between platforms (10–25s), skip after last
    if (i < scrapers.length - 1) {
      const delay = 10000 + Math.random() * 15000;
      console.log(`  ⏳  Waiting ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

  return results;
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printRunSummary(data, targetMonth) {
  console.log('\n' + '─'.repeat(60));
  console.log(`📊  RUN SUMMARY — ${targetMonth.label}`);
  console.log('─'.repeat(60));

  let anyErrors = false;

  for (const [id, prop] of Object.entries(data.properties)) {
    const entry = prop.history?.[targetMonth.key];
    if (!entry) continue;

    const p = entry.platforms;
    const fmt = (v) => v === null ? '—' : v === undefined ? '—' : String(v);

    console.log(`\n  🏨  ${prop.name}`);
    console.log(`      Booking.com : ${fmt(p.booking?.count)}${p.booking?.error ? ` ❌ ${p.booking.error}` : ''}`);
    console.log(`      Expedia     : ${fmt(p.expedia?.count)}${p.expedia?.error ? ` ❌ ${p.expedia.error}` : ''}`);
    console.log(`      Airbnb      : ${fmt(p.airbnb?.count)} new (total: ${fmt(p.airbnb?.rawTotal)})${p.airbnb?.note ? ` ℹ️  ${p.airbnb.note}` : ''}${p.airbnb?.error ? ` ❌ ${p.airbnb.error}` : ''}`);
    console.log(`      Google      : ${fmt(p.google?.count)}${p.google?.error ? ` ❌ ${p.google.error}` : ''}`);

    if (Object.values(p).some(pl => pl?.error)) anyErrors = true;
  }

  if (alerts.length > 0) {
    console.log('\n⚠️   ALERTS:');
    alerts.forEach(a => console.log(`    [${a.level.toUpperCase()}] ${a.property} / ${a.platform}: ${a.message}`));
  }

  if (anyErrors) {
    console.log('\n🔴  Some platforms had errors. Check alerts.json for details.');
  } else {
    console.log('\n🟢  All platforms completed successfully.');
  }

  console.log('─'.repeat(60) + '\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const targetMonth = getTargetMonth();

  console.log('\n' + '═'.repeat(60));
  if (isBaseline) {
    console.log('🏁  MODE: BASELINE CAPTURE');
    console.log('    Storing current Airbnb totals + current-month review counts.');
    console.log('    Run again on the 7th next month for deltas to work.');
  } else {
    console.log(`🗓️   MODE: MONTHLY RUN — counting reviews for ${targetMonth.label}`);
  }
  if (isDryRun) console.log('    DRY RUN — no data will be written');
  if (monthOverride) console.log(`    MONTH OVERRIDE: ${monthOverride}`);
  console.log('═'.repeat(60) + '\n');

  const properties = loadProperties();
  console.log(`🏨  ${properties.length} properties loaded`);

  const data = loadData();
  if (!data.properties) data.properties = {};

  if (isDryRun) {
    console.log('\n✅  Dry run complete — config valid, no scraping performed.\n');
    return;
  }

  const browser = await createStealthBrowser();

  try {
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      console.log(`\n[${i + 1}/${properties.length}] 🏨  ${property.name}`);

      // Initialise property record if first time seen
      if (!data.properties[property.id]) {
        data.properties[property.id] = { name: property.name, history: {} };
      }
      data.properties[property.id].name = property.name; // keep name in sync

      const existingPropertyData = data.properties[property.id];
      const platforms = await scrapeProperty(browser, property, targetMonth, existingPropertyData);

      data.properties[property.id].history[targetMonth.key] = {
        label: targetMonth.label,
        mode: isBaseline ? 'baseline' : 'monthly',
        scrapedAt: new Date().toISOString(),
        platforms,
      };

      // Update lastUpdated and save after EACH property — crash-safe
      data.lastUpdated = new Date().toISOString();
      saveData(data);

      if (i < properties.length - 1) {
        const delay = 20000 + Math.random() * 25000;
        console.log(`\n  ⏳  Waiting ${Math.round(delay / 1000)}s before next property...`);
        await sleep(delay);
      }
    }
  } catch (fatalErr) {
    error('SYSTEM', 'orchestrator', fatalErr.message);
    // Save whatever we have before re-throwing
    data.lastUpdated = new Date().toISOString();
    saveData(data);
    saveAlerts(targetMonth.label);
    throw fatalErr;
  } finally {
    await browser.close();
  }

  printRunSummary(data, targetMonth);
  saveAlerts(targetMonth.label);
  console.log('✅  All done!\n');
}

main().catch(err => {
  console.error('\n💥  Fatal error:', err.message);
  process.exit(1);
});
