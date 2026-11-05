const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const XLSX = require("xlsx");
const { sendScrapedReport } = require("./send-email");

const ROOT = path.resolve(__dirname, "..");
const LOGIN_URL =
  "https://wintronelectronics.com/scs/checkout.ssp?is=login&login=T&fragment=login-register#login-register";
const HOME_URL = "https://wintronelectronics.com/";

loadEnv(path.join(ROOT, ".env"));

const config = {
  email: process.env.WINTRON_EMAIL || "inventory@virventures.com",
  password: process.env.WINTRON_PASSWORD || "fgeq!@#$!DS!H3",
  outputDir: path.resolve(ROOT, process.env.OUTPUT_DIR || "output"),
  timezone: process.env.SCRAPE_TIMEZONE || "Asia/Calcutta",
  headless:
    !process.argv.includes("--headed") &&
    String(process.env.HEADLESS || "true").toLowerCase() !== "false",
};

async function main() {
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });

  const now = new Date();
  const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "short" }).format(now);
  if (["Sat", "Sun"].includes(dayOfWeek) && !process.argv.includes("--force")) {
    console.log(`[GUARD] Today is ${dayOfWeek}. Daily Sale scraper only runs Monday through Friday. (Pass --force to override).`);
    return;
  }

  const scrapeDate = formatDate(now, config.timezone);
  const scrapedAtTimestamp = formatScrapedAt(now, config.timezone);

  const logPath = path.join(ROOT, "logs", `wintron_sale_scrape_${scrapeDate}.log`);
  const log = createLogger(logPath);

  log("=======================================================");
  log(`Starting Wintron Daily Sale Products scrape: ${scrapedAtTimestamp}`);
  log("=======================================================");

  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);

    // 1. Log in
    await login(page, log);

    // 2. Go to home page to establish full session state
    await openHomePage(page, log);

    // 3. Scrape Sale products using fast Brand-Partitioned Items Stream
    let rows = [];
    let expectedTotal = 0;
    try {
      const result = await scrapeAllSaleProducts(page, scrapedAtTimestamp, log);
      rows = result.rows;
      expectedTotal = result.expectedTotal;
    } catch (scrapeErr) {
      log(`Scrape warning: ${scrapeErr.message}. Writing collected items...`);
    }

    log(`Scraped total of ${rows.length} unique Sale products (expected ~${expectedTotal || 5920}).`);

    // 4. Save to Excel
    const outputPath = writeWorkbook(rows, scrapeDate, config.outputDir);
    log(`Saved ${rows.length} Sale products to spreadsheet: ${outputPath}`);
    console.log(`OUTPUT_FILE: ${outputPath}`);

    // 5. Send file via Gmail
    log("Sending Sale spreadsheet via Gmail to recipient...");
    const emailResult = await sendScrapedReport(outputPath, {
      reportType: "sale",
      totalProducts: rows.length,
      scrapedAt: scrapedAtTimestamp,
      scrapeDate,
    });
    log(`Gmail dispatch result: ${JSON.stringify(emailResult)}`);

    log("Daily Sale scrape run finished successfully.");
  } finally {
    await browser.close();
  }
}

async function login(page, log) {
  log("1. Navigating to login page");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  await page.waitForSelector('input[name="email"], input[type="email"]', {
    timeout: 30000,
  });

  log("Filling email and password credentials");
  await page.locator('input[name="email"], input[type="email"]').first().fill(config.email);
  await page.locator('input[name="password"], input[type="password"]').first().fill(config.password);

  log("Submitting login form");
  await Promise.allSettled([
    page.waitForURL(/my_account\.ssp|customercenter/, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }),
    page.getByRole("button", { name: /Log In/i }).click(),
  ]);

  await page
    .waitForFunction(
      () => document.body && /Welcome\s+VIR VENTURES|Sign Out|My Account/i.test(document.body.innerText),
      undefined,
      { timeout: 60000 }
    )
    .catch(async () => {
      const url = page.url();
      const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      throw new Error(`Login failed or timed out. URL: ${url}. Snippet: ${body.slice(0, 300)}`);
    });

  log("Login verified successfully");
}

async function openHomePage(page, log) {
  log("2. Navigating to home page to establish session context");
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.body && /Welcome\s+VIR VENTURES|Sign Out/i.test(document.body.innerText),
    undefined,
    { timeout: 60000 }
  );
  await page.waitForTimeout(2000);
}

async function scrapeAllSaleProducts(page, timestamp, log) {
  log("3. Fetching sale catalog facet metadata...");
  const initData = await page.evaluate(async () => {
    const res = await fetch(
      "https://wintronelectronics.com/api/cacheable/items?c=7050881&country=US&currency=USD&custitem_is_on_sale=true&fieldset=search&include=facets&language=en&limit=1&n=2&offset=0&pricelevel=5&sort=relevance%3Adesc&use_pcv=T"
    );
    return await res.json();
  });

  const totalCatalogItems = initData.total || 0;
  log(`Total Sale products in catalog: ${totalCatalogItems}`);

  const brandFacet = (initData.facets || []).find((f) => f.id === "custitem_brand");
  const brands = brandFacet && Array.isArray(brandFacet.values) ? brandFacet.values : [];
  log(`Discovered ${brands.length} brand partitions.`);

  const collected = [];
  const seen = new Set();

  function addItem(item) {
    const title = (item.displayname || item.storedisplayname2 || item.itemid || "").trim();
    const mpn = (item.mpn || item.custitem_uc_mpn || item.custitem_mpn_search_ || item.itemid || "").trim();
    if (!title && !mpn) return;

    const key = `${title}|${mpn}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const listPriceNum = item.pricelevel8 != null ? item.pricelevel8 : item.custitem_uc_list_price;
    const ourPriceNum =
      item.pricelevel6 != null
        ? item.pricelevel6
        : item.pricelevel2 != null
        ? item.pricelevel2
        : item.pricelevel5 != null
        ? item.pricelevel5
        : item.onlinecustomerprice;

    const listPrice =
      listPriceNum != null ? `$${Number(listPriceNum).toFixed(2)}` : item.custitem_uc_list_price_formatted || "";
    const ourPrice =
      ourPriceNum != null
        ? `$${Number(ourPriceNum).toFixed(2)}`
        : item.onlinecustomerprice_formatted || item.pricelevel5_formatted || "";

    collected.push({
      Title: title,
      MPN: mpn,
      "List Price": listPrice,
      "Our Price": ourPrice,
      "Scraped At": timestamp,
    });
  }

  // Partition across brands so no single request ever exceeds NetSuite's 5,000 item limit
  if (brands.length > 0) {
    for (let i = 0; i < brands.length; i++) {
      const b = brands[i];
      let offset = 0;
      const limit = 100;
      let brandTotal = null;

      while (brandTotal === null || offset < brandTotal) {
        const brandUrl = `https://wintronelectronics.com/api/cacheable/items?c=7050881&country=US&currency=USD&custitem_is_on_sale=true&custitem_brand=${encodeURIComponent(
          b.url
        )}&fieldset=search&language=en&limit=${limit}&n=2&offset=${offset}&pricelevel=5&use_pcv=T`;

        let data = null;
        for (let retry = 0; retry < 3; retry++) {
          try {
            data = await page.evaluate(async (url) => {
              const res = await fetch(url);
              return await res.json();
            }, brandUrl);
            break;
          } catch (err) {
            await page.waitForTimeout(1000);
          }
        }

        if (!data || !data.items || data.items.length === 0) break;
        if (brandTotal === null) {
          brandTotal = data.total || 0;
        }

        for (const item of data.items) {
          addItem(item);
        }

        offset += limit;
      }

      if ((i + 1) % 10 === 0 || i === brands.length - 1) {
        log(`Brand progress: ${i + 1}/${brands.length} brands | Collected ${collected.length} unique products`);
      }
    }
  }

  // Fallback sweep: Check unpartitioned search to pick up any products without a brand
  if (collected.length < totalCatalogItems) {
    log(`Checking for any unbranded sale products (collected ${collected.length} / ${totalCatalogItems})...`);
    let offset = 0;
    const limit = 100;
    while (offset < 5000) {
      const unpartitionedUrl = `https://wintronelectronics.com/api/cacheable/items?c=7050881&country=US&currency=USD&custitem_is_on_sale=true&fieldset=search&language=en&limit=${limit}&n=2&offset=${offset}&pricelevel=5&use_pcv=T`;
      let data = null;
      try {
        data = await page.evaluate(async (url) => {
          const res = await fetch(url);
          return await res.json();
        }, unpartitionedUrl);
      } catch (e) {
        break;
      }
      if (!data || !data.items || data.items.length === 0) break;
      for (const item of data.items) {
        addItem(item);
      }
      offset += limit;
      if (collected.length >= totalCatalogItems) break;
    }
  }

  return { rows: collected, expectedTotal: totalCatalogItems };
}

function writeWorkbook(rows, scrapeDate, outputDir) {
  const workbook = XLSX.utils.book_new();
  const columns = ["Title", "MPN", "List Price", "Our Price", "Scraped At"];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });

  sheet["!cols"] = [
    { wch: 60 }, // Title
    { wch: 25 }, // MPN
    { wch: 15 }, // List Price
    { wch: 15 }, // Our Price
    { wch: 22 }, // Scraped At
  ];

  XLSX.utils.book_append_sheet(workbook, sheet, "Sale Products");

  const outputPath = path.join(
    outputDir,
    `Wintron_Daily_Sale_Products_${scrapeDate}.xlsx`
  );
  XLSX.writeFile(workbook, outputPath, { compression: true });
  return outputPath;
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function resolveBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome or Chromium executable was not found. Set CHROME_PATH.");
  }
  return executable;
}

function formatDate(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function formatScrapedAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute} IST`;
}

function createLogger(logPath) {
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    fs.appendFileSync(logPath, `${line}\n`);
    console.log(line);
  };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
