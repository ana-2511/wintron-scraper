# Wintron Electronics New Products Scraper & Weekly Automation

This automation tool logs into the Wintron Electronics portal, navigates to the **New** products section, scrapes all products (~145 products), generates an Excel spreadsheet with the exact requested columns, and sends it via Gmail every Monday at 11:00 AM IST.

---

## Output Details

- **Output Directory**: `output/`
- **Filename**: `Wintron_Sale_Products_YYYY-MM-DD.xlsx` (uses the actual execution date).
- **Columns (in exact order)**:
  1. `Title`
  2. `MPN`
  3. `SKU`
  4. `List Price`
  5. `Our Price`
  6. `Image Link`
  7. `Scraped At` (e.g. `2026-09-04 15:56 IST`)

---

## Configuration (`.env`)

Store credentials in `.env` (kept private and git-ignored):

```ini
WINTRON_EMAIL=inventory@virventures.com
WINTRON_PASSWORD=fgeq!@#$!DS!H3

# Gmail Dispatch Configuration
RECIPIENT_EMAIL=andrew.b@virventures.com
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_16_character_app_password

# Optional Settings
OUTPUT_DIR=output
HEADLESS=true
SCRAPE_TIMEZONE=Asia/Calcutta
```

> **Note on Gmail App Password**:
> If using Gmail / Google Workspace with 2-Step Verification, generate an **App Password** from [Google Account Security](https://myaccount.google.com/apppasswords) and paste it into `GMAIL_APP_PASSWORD`. If credentials are not yet supplied, the scraper will still generate the Excel file locally and log a clear delivery reminder.

---

## How to Run Manually

### 1. New Products Scraper (Weekly)
```powershell
node scripts/scrape-new-products.js
```
Or run: `scripts\run-weekly-scrape.bat`

### 2. Sale Products Scraper (Daily Mon-Fri)
```powershell
node scripts/scrape-sale-products.js
```
Or run: `scripts\run-daily-sale-scrape.bat`

---

## Scheduled Tasks (Windows Task Scheduler)

1. **`WintronWeeklyScraper`**:
   - **Target**: "New" products catalog (~144 products).
   - **Schedule**: Every Monday at 11:00 AM IST.
   - **Command**:
     ```cmd
     schtasks /create /tn "WintronWeeklyScraper" /tr "E:\yash_wintronelectronics\scripts\run-weekly-scrape.bat" /sc weekly /d MON /st 11:00 /f
     ```

2. **`WintronDailySaleScraper`**:
   - **Target**: "Sale" products catalog (~34 products).
   - **Schedule**: Daily from Monday to Friday at 11:00 AM IST.
   - **Command**:
     ```cmd
     schtasks /create /tn "WintronDailySaleScraper" /tr "E:\yash_wintronelectronics\scripts\run-daily-sale-scrape.bat" /sc weekly /d MON,TUE,WED,THU,FRI /st 11:00 /f
     ```

---

## 100% Cloud Automation (GitHub Actions)

To run both automations in the cloud **without needing your laptop turned on**:

### 1. Initialize Git and Push to GitHub
```powershell
git init
git add .
git commit -m "Wintron Electronics Cloud Scrapers"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

### 2. Configure GitHub Repository Secrets
In your GitHub repository, go to **Settings** > **Secrets and variables** > **Actions**, click **New repository secret**, and add:

| Secret Name | Value |
| :--- | :--- |
| `WINTRON_EMAIL` | `inventory@virventures.com` |
| `WINTRON_PASSWORD` | `fgeq!@#$!DS!H3` |
| `GMAIL_USER` | `anangsha.mini@gmail.com` |
| `GMAIL_APP_PASSWORD` | `hpeouqewjugnkstd` |
| `RECIPIENT_EMAIL` | `andrew.b@virventures.com` |

### 3. Automatic Cloud Execution
- **Weekly New Products**: Runs every **Monday at 11:00 AM IST** (`30 5 * * 1` UTC).
- **Daily Sale Products**: Runs **Monday to Friday at 11:00 AM IST** (`30 5 * * 1-5` UTC).
- Both workflows can also be manually triggered on demand via the **Actions** tab in GitHub.
- Generated Excel spreadsheets are sent directly to `andrew.b@virventures.com` and also backed up as downloadable GitHub artifacts.
