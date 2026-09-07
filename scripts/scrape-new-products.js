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
  const scrapeDate = formatDate(now, config.timezone);
  const scrapedAtTimestamp = formatScrapedAt(now, config.timezone);

  const logPath = path.join(ROOT, "logs", `wintron_scrape_${scrapeDate}.log`);
  const log = createLogger(logPath);

  log("=======================================================");
  log(`Starting Wintron Electronics scrape run: ${scrapedAtTimestamp}`);
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

    // 2. Go to home page and click "New"
    await openNewProductsFromHome(page, log);

    // 3. Scrape all products across pages
    const { rows, expectedTotal } = await scrapeAllProducts(
      page,
      scrapedAtTimestamp,
      log
    );
    log(`Scraped total of ${rows.length} unique products (expected ${expectedTotal || "all"}).`);

    // 4. Save to Excel
    const outputPath = writeWorkbook(rows, scrapeDate, config.outputDir);
    log(`Saved ${rows.length} products to spreadsheet: ${outputPath}`);
    console.log(`OUTPUT_FILE: ${outputPath}`);

    // 5. Send file via Gmail
    log("Sending spreadsheet via Gmail to recipient...");
    const emailResult = await sendScrapedReport(outputPath, {
      reportType: "new",
      totalProducts: rows.length,
      scrapedAt: scrapedAtTimestamp,
      scrapeDate,
    });
    log(`Gmail dispatch result: ${JSON.stringify(emailResult)}`);

    log("Scrape run finished successfully.");
  } finally {
    await browser.close();
  }
}

async function login(page, log) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log(`1. Navigating to login page (attempt ${attempt})`);
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

      await page.waitForSelector('input[name="email"], input[type="email"]', {
        timeout: 30000,
      });
      await page.waitForTimeout(1500);

      log("Filling email and password credentials");
      await page.locator('input[name="email"], input[type="email"]').first().fill(config.email);
      await page.locator('input[name="password"], input[type="password"]').first().fill(config.password);

      log("Submitting login form");
      await page.getByRole("button", { name: /Log In/i }).click();

      await page.waitForFunction(
        () => document.body && /Welcome\s+VIR VENTURES|Sign Out|My Account/i.test(document.body.innerText),
        undefined,
        { timeout: 45000 }
      );

      log("Login verified successfully");
      return;
    } catch (err) {
      log(`Login attempt ${attempt} failed: ${err.message}`);
      if (attempt === 2) {
        const url = page.url();
        const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        throw new Error(`Login failed or timed out. URL: ${url}. Snippet: ${body.slice(0, 300)}`);
      }
      await page.waitForTimeout(3000);
    }
  }
}

async function openNewProductsFromHome(page, log) {
  log("2. Navigating to home page");
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.body && /Welcome\s+VIR VENTURES|Sign Out/i.test(document.body.innerText),
    undefined,
    { timeout: 60000 }
  );
  await page.waitForTimeout(3000);

  log("Waiting for 'New' link in navigation...");
  await page.waitForFunction(() => {
    const anchors = Array.from(document.querySelectorAll("a"));
    return anchors.some(
      (a) =>
        (a.textContent || "").trim() === "New" &&
        (a.href.includes("custitem_uc_is_new=true") ||
          (a.getAttribute("data-hashtag") || "").includes("custitem_uc_is_new=true"))
    );
  }, undefined, { timeout: 30000 });

  log("Clicking 'New' link");
  await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a"));
    const target = anchors.find(
      (a) =>
        (a.textContent || "").trim() === "New" &&
        (a.href.includes("custitem_uc_is_new=true") ||
          (a.getAttribute("data-hashtag") || "").includes("custitem_uc_is_new=true"))
    );
    if (target) target.click();
  });

  // Wait for the New products listing to load (e.g. "144 Products")
  log("Waiting for New products listing to render...");
  await page.waitForFunction(
    () => document.querySelectorAll(".facets-item-cell-grid").length > 0 && /Products/i.test(document.body.innerText),
    undefined,
    { timeout: 30000 }
  );
  await page.waitForTimeout(2000);
  log("New products listing loaded");
}

async function scrapeAllProducts(page, timestamp, log) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const match = bodyText.match(/(\d[\d,]*)\s+Products/i);
  const expectedTotal = match ? Number(match[1].replace(/,/g, "")) : 144;
  log(`Total expected products: ${expectedTotal}`);

  const totalPages = Math.ceil(expectedTotal / 24);
  log(`Total pages to scrape: ${totalPages}`);

  const collected = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
    if (pageNum > 1) {
      log(`Advancing to page ${pageNum}...`);
      const clicked = await page.evaluate((targetPage) => {
        const links = Array.from(document.querySelectorAll("ul.global-views-pagination-links a"));
        const target = links.find((a) => a.textContent.trim() === String(targetPage));
        if (target) {
          target.click();
          return true;
        }
        return false;
      }, pageNum);

      if (clicked) {
        await page.waitForFunction(
          (p) => {
            const active = document.querySelector(".global-views-pagination-active");
            return active && active.textContent.trim() === String(p);
          },
          pageNum,
          { timeout: 15000 }
        ).catch(() => {});
      } else {
        // Fallback direct URL with literal colon
        const targetUrl = `https://wintronelectronics.com/search?order=custitem_uc_new_product_date:desc&page=${pageNum}&custitem_uc_is_new=true`;
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      }

      await page.waitForFunction(
        () => document.querySelectorAll(".facets-item-cell-grid").length > 0,
        undefined,
        { timeout: 30000 }
      );
    }

    // Brief settle time for price elements to hydrate
    await page.waitForTimeout(1500);

    const pageRows = await scrapeCurrentPage(page, timestamp);
    log(`Page ${pageNum}: Scraped ${pageRows.length} products`);
    collected.push(...pageRows);
  }

  const rows = dedupeProducts(collected);
  return { rows, expectedTotal };
}

async function scrapeCurrentPage(page, timestamp) {
  return page.$$eval(
    ".facets-item-cell-grid",
    (cards, scrapedAt) => {
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, " ").trim() : "");
      const priceByLabel = (card, label) => {
        const priceRows = [...card.querySelectorAll(".prices-module-price")];
        const row = priceRows.find((item) => text(item).toLowerCase().includes(label.toLowerCase()));
        if (row) {
          const val = row.querySelector(".prices-module-price-value");
          return val ? text(val) : text(row);
        }
        return "";
      };

      return cards
        .map((card) => {
          const titleEl = card.querySelector(".facets-item-cell-grid-title");
          const title = text(titleEl);

          const sku = card.getAttribute("data-sku") || "";

          let mpn = "";
          const pElements = [...card.querySelectorAll("p")];
          const mpnEl = pElements.find((p) => /^MPN:\s*/i.test(text(p)));
          if (mpnEl) {
            mpn = text(mpnEl).replace(/^MPN:\s*/i, "").trim();
          } else {
            mpn = sku;
          }

          const listPrice = priceByLabel(card, "List Price");
          const ourPrice = priceByLabel(card, "Our Price");

          const imgEl = card.querySelector("img.facets-item-cell-grid-image, img[itemprop='image'], img");
          let imageLink = imgEl ? (imgEl.src || imgEl.getAttribute("src") || "") : "";
          if (imageLink) {
            // NetSuite SuiteCommerce 1200x1200 high-res preset (resizeid=5&resizeh=1200&resizew=1200)
            const baseUrl = imageLink.split("?")[0];
            imageLink = `${baseUrl}?resizeid=5&resizeh=1200&resizew=1200`;
          }

          // Columns: Title | MPN | SKU | List Price | Our Price | Image Link | Scraped At
          return {
            Title: title,
            MPN: mpn,
            SKU: sku,
            "List Price": listPrice,
            "Our Price": ourPrice,
            "Image Link": imageLink,
            "Scraped At": scrapedAt,
          };
        })
        .filter((item) => item.Title || item.MPN);
    },
    timestamp
  );
}

function dedupeProducts(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = `${row.Title}|${row.MPN}`.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(row);
    }
  }
  return result;
}

function writeWorkbook(rows, scrapeDate, outputDir) {
  const workbook = XLSX.utils.book_new();
  const columns = ["Title", "MPN", "SKU", "List Price", "Our Price", "Image Link", "Scraped At"];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });

  sheet["!cols"] = [
    { wch: 60 }, // Title
    { wch: 22 }, // MPN
    { wch: 20 }, // SKU
    { wch: 15 }, // List Price
    { wch: 15 }, // Our Price
    { wch: 75 }, // Image Link
    { wch: 22 }, // Scraped At
  ];

  XLSX.utils.book_append_sheet(workbook, sheet, "New Products");

  const outputPath = path.join(
    outputDir,
    `Wintron_New_Products_${scrapeDate}.xlsx`
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
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
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
