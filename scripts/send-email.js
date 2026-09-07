const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");

const ROOT = path.resolve(__dirname, "..");
loadEnv(path.join(ROOT, ".env"));

async function sendScrapedReport(filePath, metadata = {}) {
  const recipient = process.env.RECIPIENT_EMAIL || "andrew.b@virventures.com";
  const senderUser = (process.env.GMAIL_USER || "").trim();
  const senderPass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

  if (!fs.existsSync(filePath)) {
    throw new Error(`Attachment file not found: ${filePath}`);
  }

  const fileName = path.basename(filePath);
  const totalCount = metadata.totalProducts ?? "N/A";
  const scrapeTime = metadata.scrapedAt ?? new Date().toLocaleString("en-IN", { timeZone: "Asia/Calcutta" });

  if (!senderUser || !senderPass) {
    const warning = [
      "============================================================",
      "[EMAIL NOTICE]",
      "Gmail dispatch was skipped because GMAIL_USER and/or",
      "GMAIL_APP_PASSWORD are not yet configured in .env.",
      `Target Recipient: ${recipient}`,
      `File ready to attach: ${filePath}`,
      "To enable automated Gmail delivery:",
      "  1. Open .env",
      "  2. Set GMAIL_USER=your_email@gmail.com",
      "  3. Generate a 16-character Google App Password and set:",
      "     GMAIL_APP_PASSWORD=your_app_password",
      "============================================================",
    ].join("\n");
    console.warn(warning);
    return { sent: false, reason: "MISSING_CREDENTIALS", filePath };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: senderUser,
      pass: senderPass,
    },
  });

  const isSale =
    metadata.reportType === "sale" ||
    /daily_sale/i.test(fileName) ||
    /sale/i.test(metadata.reportType || "");

  const reportTitle = isSale
    ? "Daily Sale Products Report"
    : "Weekly New Products Report";

  const emailSubject = isSale
    ? `Wintron Sale Products Report (Daily) - ${metadata.scrapeDate || fileName}`
    : `Wintron New Products Report (Weekly) - ${metadata.scrapeDate || fileName}`;

  const introText = isSale
    ? "Please find attached the daily Wintron Electronics Sale products report."
    : "Please find attached the weekly Wintron Electronics New products report.";

  const scheduleNote = isSale
    ? "This email is automatically generated and sent Monday to Friday at 11:00 AM IST."
    : "This email is automatically generated and sent every Monday at 11:00 AM IST.";

  const mailOptions = {
    from: `"Wintron Scraper" <${senderUser}>`,
    to: recipient,
    subject: emailSubject,
    text: [
      `Hello,`,
      ``,
      introText,
      ``,
      `• Report: ${reportTitle}`,
      `• Total Products: ${totalCount}`,
      `• Scraped At (IST): ${scrapeTime}`,
      `• File Attached: ${fileName}`,
      ``,
      scheduleNote,
      ``,
      `Regards,`,
      `Automated Scraper System`,
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #0b5394;">Wintron Electronics - ${reportTitle}</h2>
        <p>Hello,</p>
        <p>${introText}</p>
        <table style="border-collapse: collapse; margin: 15px 0;">
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; background-color: #f2f2f2; border: 1px solid #ddd;">Report Type</td>
            <td style="padding: 6px 12px; border: 1px solid #ddd;">${reportTitle}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; background-color: #f2f2f2; border: 1px solid #ddd;">Total Products</td>
            <td style="padding: 6px 12px; border: 1px solid #ddd;">${totalCount}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; background-color: #f2f2f2; border: 1px solid #ddd;">Scraped At (IST)</td>
            <td style="padding: 6px 12px; border: 1px solid #ddd;">${scrapeTime}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; background-color: #f2f2f2; border: 1px solid #ddd;">File Attached</td>
            <td style="padding: 6px 12px; border: 1px solid #ddd;">${fileName}</td>
          </tr>
        </table>
        <p style="color: #666; font-size: 12px;">${scheduleNote}</p>
      </div>
    `,
    attachments: [
      {
        filename: fileName,
        path: filePath,
      },
    ],
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`[EMAIL] Report successfully sent to ${recipient} (Message ID: ${info.messageId})`);
  return { sent: true, messageId: info.messageId, recipient };
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

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/send-email.js <path-to-excel-file>");
    process.exit(1);
  }
  sendScrapedReport(target)
    .then((res) => {
      console.log("Email dispatch completed:", res);
    })
    .catch((err) => {
      console.error("Failed to send email:", err);
      process.exit(1);
    });
}

module.exports = { sendScrapedReport };
