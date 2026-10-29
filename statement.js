"use strict";

/* =========================================================================
   Zoho Books — FCY Account Statement
   Minimal, print-ready A4 portrait statement. Data is passed from popup.js
   through chrome.storage.

   Multi-currency accounts are rendered as:
     1. base-currency consolidated position (the only additive total),
     2. a position table per currency (no cross-currency total),
     3. one detail section per currency with its own opening/running balance.
   Single-currency accounts keep the original one-page layout.
   ========================================================================= */

const STORAGE_KEY = "fcy_statement_data";

const CURRENCY_NAMES = {
  SDG: "الجنيه السوداني",
  SAR: "الريال السعودي",
  AED: "الدرهم الإماراتي",
  USD: "الدولار الأمريكي",
  EUR: "اليورو",
  TRY: "الليرة التركية",
  EGP: "الجنيه المصري",
  QAR: "الريال القطري",
  KWD: "الدينار الكويتي",
  OMR: "الريال العماني",
  BHD: "الدينار البحريني",
  JOD: "الدينار الأردني",
  GBP: "الجنيه الإسترليني",
  CNY: "اليوان الصيني",
  INR: "الروبية الهندية",
  CAD: "الدولار الكندي",
  AUD: "الدولار الأسترالي"
};

const MONTHS_AR = ["ينا", "فبر", "مار", "أبر", "ماي", "يون", "يول", "أغس", "سبت", "أكت", "نوف", "ديس"];

const $ = (id) => document.getElementById(id);

/* ----------------------------- helpers --------------------------------- */

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined || value === "") return 0;
  let text = String(value).trim();
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  text = text.replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)));
  text = text.replace(/[,\s٬]/g, "").replace(/[^\d.+-]/g, "");
  const parsed = parseFloat(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(value) {
  return toNumber(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtCell(value) {
  const number = toNumber(value);
  return Math.abs(number) < 0.005 ? "" : fmt(number);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/* "2026-10-01" -> "01 أكت 2026" */
function shortDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "");
  const month = Number(match[2]);
  if (!month || month > 12) return String(value || "");
  return `${match[3]} ${MONTHS_AR[month - 1]} ${match[1]}`;
}

function isoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/* Renders a date as day-month-year left-to-right (like Zoho). */
function displayDate(value) {
  const iso = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const text = iso ? shortDate(value) : String(value || "");
  const parts = text.match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (!parts) return `<span class="ltr">${esc(text)}</span>`;
  return `<span class="ltr">${parts[1]} <bdi>${esc(parts[2])}</bdi> ${parts[3]}</span>`;
}

function currencyLabel(code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return "غير محددة";
  const name = CURRENCY_NAMES[clean];
  return name ? `${name} (${clean})` : clean;
}

function currencyShortName(code) {
  const clean = String(code || "").trim().toUpperCase();
  return CURRENCY_NAMES[clean] || "";
}

function statementReference(data) {
  const parts = String(data.from || "").split("-");
  const stamp = parts.length === 3 ? `${parts[0]}${parts[1]}${parts[2]}` : "";
  const tail = String(data.accountCode || data.accId || "").replace(/\D/g, "").slice(-4).padStart(4, "0");
  return `FCY-${stamp}-${tail}`;
}

function childrenLabel(count) {
  const number = Number(count) || 0;
  if (number === 1) return "شامل حساب فرعي واحد";
  if (number === 2) return "شامل حسابين فرعيين";
  return `شامل ${number} حسابات فرعية`;
}

/* Credit-normal accounts grow with credits, debit-normal accounts with debits. */
function signedValue(debit, credit, normalSide) {
  return normalSide === "credit" ? credit - debit : debit - credit;
}

/* Keep date-like tokens inside free-text descriptions on one line. */
function protectDates(escapedText) {
  return escapedText.replace(/\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}/g, (match) => `<span class="ltr" style="white-space:nowrap">${match}</span>`);
}

/* ------------------------------ grouping ------------------------------- */

function groupByCurrency(txns) {
  const order = [];
  const map = new Map();

  txns.forEach((txn) => {
    const code = String(txn.currency || "").toUpperCase();
    if (!map.has(code)) {
      map.set(code, []);
      order.push(code);
    }
    map.get(code).push(txn);
  });

  return order.map((code) => ({ code, rows: map.get(code) }));
}

function buildGroups(txns, openings, normalSide) {
  return groupByCurrency(txns).map(({ code, rows }) => {
    const openingEntry = openings[code] || { debit: 0, credit: 0 };
    const opening = signedValue(openingEntry.debit, openingEntry.credit, normalSide);
    const debit = rows.reduce((sum, txn) => sum + txn.debit, 0);
    const credit = rows.reduce((sum, txn) => sum + txn.credit, 0);
    const closing = opening + signedValue(debit, credit, normalSide);
    return { code, rows, opening, debit, credit, closing };
  }).filter((group) => group.rows.length > 0 || Math.abs(group.opening) > 0.004);
}

/* ------------------------------ markup --------------------------------- */

function ledgerTable(group, data, normalSide) {
  let running = group.opening;

  const rows = group.rows.map((txn) => {
    running += signedValue(txn.debit, txn.credit, normalSide);

    const metaParts = [];
    if (data.includeChildren && txn.accountName) metaParts.push(txn.accountName);
    if (txn.offset) metaParts.push(txn.offset);
    if (txn.ref) metaParts.push(`مرجع ${txn.ref}`);

    return `
      <tr>
        <td class="date">${displayDate(txn.date) || "—"}</td>
        <td class="type">${esc(txn.type)}</td>
        <td class="details">
          <div>${txn.desc ? protectDates(esc(txn.desc)) : "—"}</div>
          ${metaParts.length ? `<div class="meta">${esc(metaParts.join(" · "))}</div>` : ""}
        </td>
        <td class="num-cell">${fmtCell(txn.debit)}</td>
        <td class="num-cell">${fmtCell(txn.credit)}</td>
        <td class="num-cell balance">${fmtCell(running)}</td>
      </tr>`;
  }).join("");

  return `
    <table class="ledger">
      <colgroup>
        <col style="width: 14%">
        <col style="width: 15%">
        <col>
        <col style="width: 11%">
        <col style="width: 11%">
        <col style="width: 13%">
      </colgroup>
      <thead>
        <tr>
          <th>التاريخ</th>
          <th>المعاملات</th>
          <th>التفاصيل</th>
          <th class="num-head">مدين</th>
          <th class="num-head">دائن</th>
          <th class="num-head">الرصيد</th>
        </tr>
      </thead>
      <tbody>
        <tr class="opening-row">
          <td class="date">${displayDate(data.from)}</td>
          <td class="opening-label" colspan="2">*** الرصيد الافتتاحي ***</td>
          <td class="num-cell"></td>
          <td class="num-cell"></td>
          <td class="num-cell balance">${fmt(group.opening)}</td>
        </tr>
        ${rows}
        <tr class="totals-row">
          <td colspan="3" class="totals-label">الإجماليات</td>
          <td class="num-cell">${fmt(group.debit)}</td>
          <td class="num-cell">${fmt(group.credit)}</td>
          <td class="num-cell balance">${fmt(group.closing)}</td>
        </tr>
      </tbody>
    </table>`;
}

function movementLabel(count) {
  const number = Number(count) || 0;
  if (number === 1) return "حركة واحدة";
  if (number === 2) return "حركتان";
  if (number >= 3 && number <= 10) return `${number} حركات`;
  return `${number} حركة`;
}

function summaryBlock({ title, opening, debit, credit, closing, currencyCode, totalLabel }) {
  const unit = `<span class="currency">${esc(currencyCode || "")}</span>`;
  return `
    <section class="summary">
      <div class="summary-head">${esc(title)}</div>
      <div class="summary-row">
        <span class="summary-label">الرصيد الافتتاحي</span>
        <span class="summary-value"><span class="amount">${fmt(opening)}</span>${unit}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">إجمالي المدين</span>
        <span class="summary-value"><span class="amount">${fmt(debit)}</span>${unit}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">إجمالي الدائن</span>
        <span class="summary-value"><span class="amount">${fmt(credit)}</span>${unit}</span>
      </div>
      <div class="summary-row total">
        <span class="summary-label">${esc(totalLabel || "صافي المركز")}</span>
        <span class="summary-value"><span class="amount">${fmt(closing)}</span>${unit}</span>
      </div>
    </section>`;
}

/* ------------------------------ render --------------------------------- */

function render(data) {
  const sourceRows = Array.isArray(data.txns) ? data.txns : [];
  const txns = sourceRows.map((txn) => ({
    date: txn.date || "",
    type: txn.type || "معاملة",
    ref: txn.ref || "",
    offset: txn.offset || "",
    desc: txn.desc || "",
    accountName: txn.accountName || "",
    currency: String(txn.currency || "").toUpperCase(),
    debit: toNumber(txn.debitFCY),
    credit: toNumber(txn.creditFCY)
  }));

  const normalSide = data.normalSide === "debit" ? "debit" : "credit";
  const openings = data.openings && typeof data.openings === "object" ? data.openings : {};
  const baseOpening = data.baseOpening && typeof data.baseOpening === "object"
    ? { debit: toNumber(data.baseOpening.debit), credit: toNumber(data.baseOpening.credit) }
    : { debit: 0, credit: 0 };

  const groups = buildGroups(txns, openings, normalSide);
  const multi = groups.length > 1;

  const baseDebit = sourceRows.reduce((sum, txn) => sum + toNumber(txn.baseDebit), 0);
  const baseCredit = sourceRows.reduce((sum, txn) => sum + toNumber(txn.baseCredit), 0);
  const baseOpeningValue = signedValue(baseOpening.debit, baseOpening.credit, normalSide);
  const baseClosing = baseOpeningValue + signedValue(baseDebit, baseCredit, normalSide);
  const hasBase = Boolean(data.hasBase) &&
    (Math.abs(baseDebit) + Math.abs(baseCredit) + Math.abs(baseOpening.debit) + Math.abs(baseOpening.credit) > 0.004);
  const baseCurrency = String(data.baseCurrency || "").toUpperCase();

  const generated = data.generatedAt ? new Date(data.generatedAt) : new Date();
  const generatedIso = isoDate(Number.isNaN(generated.getTime()) ? new Date() : generated);
  const reference = statementReference(data);
  const periodLabel = `${displayDate(data.from)} <span style="color:#777;margin:0 6px">إلى</span> ${displayDate(data.to)}`;
  const single = groups[0] || { code: "", rows: [], opening: 0, debit: 0, credit: 0, closing: 0 };
  const displayCurrency = multi ? "" : (single.code || String(data.currency || "").toUpperCase());

  document.title = `كشف الحسابات${multi ? " (متعدد العملات)" : ""} - ${data.accName || "حساب"} - ${shortDate(data.from)} إلى ${shortDate(data.to)}`;

  const toolbarText = $("toolbarText");
  if (toolbarText) {
    toolbarText.textContent = `${data.accName || ""} · ${shortDate(data.from)} — ${shortDate(data.to)}${multi ? " · متعدد العملات" : ""}`;
  }

  const baseHeadTitle = baseCurrency
    ? `المركز المالي — بالعملة الأساسية (${baseCurrency})`
    : "المركز المالي — بالعملة الأساسية";

  const baseSummary = hasBase
    ? summaryBlock({
        title: baseHeadTitle,
        opening: baseOpeningValue,
        debit: baseDebit,
        credit: baseCredit,
        closing: baseClosing,
        currencyCode: baseCurrency,
        totalLabel: "صافي المركز"
      })
    : "";

  const positionsTable = multi ? `
    <table class="positions">
      <thead>
        <tr>
          <th>العملة</th>
          <th class="num-head">الرصيد الافتتاحي</th>
          <th class="num-head">مدين</th>
          <th class="num-head">دائن</th>
          <th class="num-head">الرصيد الختامي</th>
        </tr>
      </thead>
      <tbody>
        ${groups.map((group) => `
          <tr>
            <td class="currency">
              <strong>${esc(group.code || "غير محددة")}</strong>
              ${currencyShortName(group.code) ? `<span>${esc(currencyShortName(group.code))}</span>` : ""}
            </td>
            <td class="num-cell">${fmt(group.opening)}</td>
            <td class="num-cell">${fmt(group.debit)}</td>
            <td class="num-cell">${fmt(group.credit)}</td>
            <td class="num-cell balance">${fmt(group.closing)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <p class="positions-note">لا تُجمع أرصدة العملات المختلفة مباشرة. القيمة الوحيدة القابلة للجمع هي المركز بالعملة الأساسية${hasBase ? "" : "، ولم تُرجع Zoho قيماً بالعملة الأساسية لهذه الحركات"}. تفاصيل كل عملة في الصفحات التالية.</p>
  ` : "";

  const sections = multi ? groups.map((group, index) => `
    <section class="currency-section${index === 0 ? " section-start" : ""}">
      <div class="section-head">
        <div>
          <div class="section-account">${esc(data.accName)} · ${shortDate(data.from)} — ${shortDate(data.to)}</div>
          <h2>تفاصيل العملة — ${esc(group.code || "غير محددة")}</h2>
          <div class="section-sub">${esc(currencyLabel(group.code))} · ${movementLabel(group.rows.length)} · الرصيد الافتتاحي ${fmt(group.opening)}</div>
        </div>
        <div class="section-closing">
          الرصيد الختامي
          <strong><span class="ltr">${fmt(group.closing)}</span> <span>${esc(group.code || "")}</span></strong>
        </div>
      </div>
      ${ledgerTable(group, data, normalSide)}
    </section>`).join("") : "";

  const singleSummary = !multi
    ? summaryBlock({
        title: "ملخص الحساب",
        opening: single.opening,
        debit: single.debit,
        credit: single.credit,
        closing: single.closing,
        currencyCode: displayCurrency,
        totalLabel: "الرصيد المستحق"
      })
    : "";

  const singleTable = !multi ? ledgerTable(single, data, normalSide) : "";

  const finePrint = multi
    ? `الأرصدة الأصلية معروضة بعملة كل حركة، والقيم بالعملة الأساسية محسوبة من أسعار الصرف المسجلة في المستندات.
       لا تُجمع العملات المختلفة مباشرة، والأرصدة السالبة تعني رصيداً معاكساً لطبيعة الحساب.`
    : `المبالغ معروضة بالعملة الأصلية (${esc(currencyLabel(displayCurrency))}) كما وردت في مستندات Zoho Books،
       ولا تتضمن أي حركة مسجلة بعد تاريخ نهاية الفترة. الأرصدة السالبة تعني رصيداً معاكساً لطبيعة الحساب.`;

  const sheet = $("statementContent");
  sheet.innerHTML = `
    <header class="letterhead">
      <img class="logo" src="assets/logo.png" alt="Rossel Global">
    </header>

    <section class="doc-heading">
      <h1>كشف الحسابات</h1>
      <div class="period">${periodLabel}</div>
      ${multi ? `<div class="doc-subnote">كشف متعدد العملات — ${groups.map((group) => esc(group.code || "غير محددة")).join(" · ")}</div>` : ""}
    </section>

    <div class="recipient">
      <span class="label">إلى:</span>
      <span class="name">${esc(data.accName) || "—"}</span>
      ${data.accountCode ? `<span class="code">(${esc(data.accountCode)})</span>` : ""}
      ${data.includeChildren ? `<span class="child-note">${childrenLabel(data.childrenCount)}</span>` : ""}
    </div>

    ${baseSummary}
    ${positionsTable}
    ${singleSummary}
    ${singleTable}
    ${sections}

    <div class="fine-print">${finePrint}</div>

    <footer class="doc-footer">
      <span>Zoho Books</span>
      <span>تاريخ الإصدار: ${displayDate(generatedIso)} · <span class="ref">${esc(reference)}</span></span>
    </footer>
  `;
}

function showError(message) {
  const sheet = $("statementContent");
  sheet.innerHTML = `
    <div class="error-card">
      <div class="error-title">تعذّر عرض كشف الحساب</div>
      <div>${esc(message)}</div>
      <div style="margin-top:8px;">أغلق هذا التبويب وافتح الإضافة مرة أخرى لإنشاء الكشف.</div>
    </div>`;
}

/* ------------------------------- boot ---------------------------------- */

async function loadStatementData() {
  try {
    const fromSession = await chrome.storage.session.get(STORAGE_KEY);
    if (fromSession && fromSession[STORAGE_KEY]) return fromSession[STORAGE_KEY];
  } catch (err) {
    /* storage.session may be unavailable in some contexts */
  }
  try {
    const fromLocal = await chrome.storage.local.get(STORAGE_KEY);
    if (fromLocal && fromLocal[STORAGE_KEY]) return fromLocal[STORAGE_KEY];
  } catch (err) {
    /* ignore */
  }
  return null;
}

document.addEventListener("DOMContentLoaded", async () => {
  const printButton = $("printBtn");
  if (printButton) {
    printButton.addEventListener("click", () => window.print());
  }

  const data = await loadStatementData();
  if (!data) {
    showError("لم يتم العثور على بيانات الكشف.");
    return;
  }

  try {
    render(data);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
});
