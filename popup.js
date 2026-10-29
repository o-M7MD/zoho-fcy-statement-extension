"use strict";

/* =========================================================================
   Zoho Books — FCY Account Statement (popup controller)
   Reads the chart of accounts from the open Zoho Books tab, auto-detects the
   account of the report currently on screen, extracts every transaction in
   its original currency, and hands the result to statement.html (PDF/print)
   or downloads it as CSV.
   ========================================================================= */

const STORAGE_KEY = "fcy_statement_data";
const PREFS_KEY = "fcy_prefs";

const DEBIT_NORMAL_TYPES = new Set([
  "accounts_receivable",
  "other_current_asset",
  "cash",
  "bank",
  "fixed_asset",
  "other_asset",
  "stock",
  "prepaid_expense",
  "expense",
  "cost_of_goods_sold",
  "other_expense"
]);

const ACCOUNT_TYPE_LABELS = {
  other_current_asset: "أصول متداولة أخرى",
  cash: "نقدية",
  bank: "بنك",
  fixed_asset: "أصول ثابتة",
  other_asset: "أصول أخرى",
  stock: "مخزون",
  expense: "مصروفات",
  cost_of_goods_sold: "تكلفة المبيعات",
  other_expense: "مصروفات أخرى",
  accounts_receivable: "مدينون",
  other_current_liability: "التزامات متداولة أخرى",
  accounts_payable: "دائنون",
  credit_card: "بطاقة ائتمان",
  long_term_liability: "التزامات طويلة الأجل",
  other_liability: "التزامات أخرى",
  equity: "حقوق ملكية",
  income: "إيرادات",
  other_income: "إيرادات أخرى"
};

const PERIOD_OPTIONS = [
  ["this_month", "هذا الشهر"],
  ["last_month", "الشهر الماضي"],
  ["this_quarter", "هذا الربع"],
  ["last_quarter", "الربع الماضي"],
  ["this_year", "هذه السنة"],
  ["last_year", "السنة الماضية"],
  ["this_week", "هذا الأسبوع"],
  ["last_week", "الأسبوع الماضي"],
  ["custom", "نطاق مخصص…"]
];

const el = {
  statusBox: document.getElementById("statusBox"),
  statusText: document.getElementById("statusText"),
  form: document.getElementById("mainForm"),
  combo: document.querySelector(".combo"),
  accountSearch: document.getElementById("accountSearch"),
  accountList: document.getElementById("accountList"),
  clearAccount: document.getElementById("clearAccount"),
  accountMeta: document.getElementById("accountMeta"),
  childRow: document.getElementById("childRow"),
  childLabel: document.getElementById("childLabel"),
  includeChildren: document.getElementById("includeChildren"),
  detectNote: document.getElementById("detectNote"),
  periodPreset: document.getElementById("periodPreset"),
  customDateRow: document.getElementById("customDateRow"),
  fromDate: document.getElementById("fromDate"),
  toDate: document.getElementById("toDate"),
  pdfBtn: document.getElementById("generatePdfBtn"),
  pdfBtnText: document.getElementById("pdfBtnText"),
  pdfSpinner: document.getElementById("pdfSpinner"),
  csvBtn: document.getElementById("exportCsvBtn"),
  csvBtnText: document.getElementById("csvBtnText")
};

const state = {
  tabId: null,
  orgId: "",
  baseCurrency: "",
  accounts: [],
  filtered: [],
  selected: null,
  activeIndex: -1,
  busy: false,
  prefs: {},
  childrenIndex: new Map(),
  descendants: []
};

/* ------------------------------- dates --------------------------------- */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthRange(year, month) {
  return {
    from: isoDate(new Date(year, month, 1)),
    to: isoDate(new Date(year, month + 1, 0))
  };
}

function quarterRange(year, quarter) {
  const startMonth = quarter * 3;
  return {
    from: isoDate(new Date(year, startMonth, 1)),
    to: isoDate(new Date(year, startMonth + 3, 0))
  };
}

function weekRange(offsetWeeks) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - start.getDay() + offsetWeeks * 7); /* week starts Sunday */
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { from: isoDate(start), to: isoDate(end) };
}

function resolvePeriod(value) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (value) {
    case "this_month": return monthRange(year, month);
    case "last_month": return monthRange(year, month - 1);
    case "this_quarter": return quarterRange(year, Math.floor(month / 3));
    case "last_quarter": {
      const quarter = Math.floor(month / 3) - 1;
      return quarter < 0 ? quarterRange(year - 1, 3) : quarterRange(year, quarter);
    }
    case "this_year": return { from: `${year}-01-01`, to: `${year}-12-31` };
    case "last_year": return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case "this_week": return weekRange(0);
    case "last_week": return weekRange(-1);
    default: return null;
  }
}

function periodLabel(value) {
  const found = PERIOD_OPTIONS.find((option) => option[0] === value);
  return found ? found[1] : "";
}

/* ----------------------------- helpers --------------------------------- */

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

function normalizeSearch(text) {
  return String(text === null || text === undefined ? "" : text)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function setStatus(message, type) {
  el.statusBox.className = `status ${type || ""}`.trim();
  el.statusText.textContent = message;
  el.statusBox.hidden = false;
}

function hideStatus() {
  el.statusBox.hidden = true;
}

function friendlyError(error) {
  const raw = error && error.message ? error.message : String(error);
  if (/cannot access|Cannot access contents|permission/i.test(raw)) {
    return "تعذّر الوصول إلى تبويب Zoho Books. أعد تحميل صفحة Zoho ثم افتح الإضافة مرة أخرى.";
  }
  if (/Failed to fetch|NetworkError/i.test(raw)) {
    return "تعذّر الاتصال بخادم Zoho Books. تحقّق من اتصال الإنترنت ثم أعد المحاولة.";
  }
  return raw;
}

function isZohoUrl(url) {
  return typeof url === "string" && /^https:\/\/books\.zoho\.[a-z.]+/i.test(url);
}

/* ------------------------------ busy state ----------------------------- */

function setBusy(kind, busy) {
  state.busy = busy;
  el.pdfBtn.disabled = busy;
  el.csvBtn.disabled = busy;
  const isPdf = kind === "pdf";
  el.pdfSpinner.hidden = !(busy && isPdf);
  el.pdfBtnText.textContent = busy && isPdf ? "جارٍ استخراج الحركات…" : "عرض الكشف وحفظه PDF";
  el.csvBtnText.textContent = busy && !isPdf ? "جارٍ تجهيز الملف…" : "تصدير إلى CSV";
}

/* ---------------------------- account combobox ------------------------- */

function closeList() {
  el.accountList.hidden = true;
  el.accountSearch.setAttribute("aria-expanded", "false");
  state.activeIndex = -1;
}

function openList() {
  if (!el.accountList.hidden) return;
  el.accountList.hidden = false;
  el.accountSearch.setAttribute("aria-expanded", "true");
}

function renderList(query) {
  const needle = normalizeSearch(query === undefined ? el.accountSearch.value : query);

  state.filtered = state.accounts
    .filter((account) => {
      if (!needle) return true;
      return normalizeSearch(account.name).includes(needle) || normalizeSearch(account.code).includes(needle);
    })
    .sort((a, b) => {
      const activeA = a.active ? 0 : 1;
      const activeB = b.active ? 0 : 1;
      if (activeA !== activeB) return activeA - activeB;
      return a.name.localeCompare(b.name, "ar");
    });

  state.activeIndex = -1;

  if (state.filtered.length === 0) {
    el.accountList.innerHTML = `<div class="combo-empty">لا توجد حسابات مطابقة</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filtered.forEach((account, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "combo-item";
    item.dataset.id = account.id;
    item.dataset.index = String(index);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", state.selected && state.selected.id === account.id ? "true" : "false");
    item.innerHTML = `
      <span class="ci-top">
        <span class="ci-name">${escapeHtml(account.name)}</span>
        ${account.code ? `<span class="ci-code">${escapeHtml(account.code)}</span>` : ""}
      </span>
      <span class="ci-sub">
        <span>${escapeHtml(ACCOUNT_TYPE_LABELS[account.type] || "حساب")}</span>
        ${account.currency ? `<span>· ${escapeHtml(account.currency)}</span>` : ""}
      </span>`;
    fragment.appendChild(item);
  });

  el.accountList.innerHTML = "";
  el.accountList.appendChild(fragment);
}

function highlightItem(nextIndex) {
  const items = Array.from(el.accountList.querySelectorAll(".combo-item"));
  if (items.length === 0) return;
  const bounded = Math.max(0, Math.min(items.length - 1, nextIndex));
  items.forEach((item) => item.classList.remove("is-active"));
  const active = items[bounded];
  active.classList.add("is-active");
  active.scrollIntoView({ block: "nearest" });
  state.activeIndex = bounded;
}

function renderMeta(account) {
  if (!account) {
    el.accountMeta.hidden = true;
    el.accountMeta.innerHTML = "";
    return;
  }
  const chips = [];
  if (account.code) chips.push(`<span class="chip">${escapeHtml(account.code)}</span>`);
  chips.push(`<span class="chip">${escapeHtml(ACCOUNT_TYPE_LABELS[account.type] || "حساب")}</span>`);
  if (account.currency) chips.push(`<span class="chip">${escapeHtml(account.currency)}</span>`);
  el.accountMeta.innerHTML = chips.join("");
  el.accountMeta.hidden = false;
}

/* --------------------------- sub-accounts ------------------------------ */

function buildChildrenIndex() {
  state.childrenIndex = new Map();

  state.accounts.forEach((account) => {
    let parentId = account.parentId;
    if (!parentId && account.parentName) {
      const parent = state.accounts.find((entry) => entry.name === account.parentName);
      if (parent) parentId = parent.id;
    }
    if (!parentId) return;
    const children = state.childrenIndex.get(parentId) || [];
    children.push(account);
    state.childrenIndex.set(parentId, children);
  });
}

function collectDescendants(accountId) {
  const result = [];
  const seen = new Set();
  const queue = [accountId];

  while (queue.length > 0) {
    const current = queue.shift();
    const children = state.childrenIndex.get(current) || [];
    children.forEach((child) => {
      if (seen.has(child.id)) return;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    });
  }

  return result;
}

function updateChildOption(account) {
  state.descendants = account ? collectDescendants(account.id) : [];

  if (!account || state.descendants.length === 0) {
    el.childRow.hidden = true;
    el.includeChildren.checked = false;
    return;
  }

  el.childRow.hidden = false;
  el.childLabel.textContent = `تضمين معاملات الحسابات الفرعية (${state.descendants.length})`;
  el.includeChildren.checked = Boolean(state.prefs.includeChildren);
}

function includeChildrenSelected() {
  return !el.childRow.hidden && el.includeChildren.checked && state.descendants.length > 0;
}

function selectedAccountIds(account) {
  if (!includeChildrenSelected()) return [account.id];
  return [account.id, ...state.descendants.map((child) => child.id)];
}

function selectAccount(account) {
  state.selected = account;
  el.accountSearch.value = account.name;
  el.clearAccount.hidden = false;
  el.detectNote.hidden = true;
  renderMeta(account);
  updateChildOption(account);
  closeList();
  savePrefs({ lastAccountId: account.id });
  hideStatus();
}

function clearSelection() {
  state.selected = null;
  state.descendants = [];
  el.accountSearch.value = "";
  el.clearAccount.hidden = true;
  el.childRow.hidden = true;
  el.includeChildren.checked = false;
  renderMeta(null);
  el.detectNote.hidden = true;
  el.accountSearch.focus();
  renderList("");
  openList();
}

function showDetectNote(text) {
  el.detectNote.textContent = text;
  el.detectNote.hidden = false;
}

/* -------------------------------- prefs -------------------------------- */

async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get(PREFS_KEY);
    return (stored && stored[PREFS_KEY]) || {};
  } catch (err) {
    return {};
  }
}

function savePrefs(patch) {
  chrome.storage.local.get(PREFS_KEY).then((stored) => {
    const next = { ...((stored && stored[PREFS_KEY]) || {}), ...patch };
    return chrome.storage.local.set({ [PREFS_KEY]: next });
  }).catch(() => { /* preferences are optional */ });
}

/* ------------------------------- periods ------------------------------- */

function applyPeriod(value) {
  if (value === "custom") {
    el.customDateRow.hidden = false;
    if (!el.fromDate.value || !el.toDate.value) {
      const range = resolvePeriod("this_month");
      el.fromDate.value = range.from;
      el.toDate.value = range.to;
    }
    return;
  }

  const range = resolvePeriod(value);
  el.customDateRow.hidden = true;
  if (range) {
    el.fromDate.value = range.from;
    el.toDate.value = range.to;
  }
}

function buildPeriodOptions(preferred) {
  el.periodPreset.innerHTML = PERIOD_OPTIONS
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  const allowed = new Set(PERIOD_OPTIONS.map((option) => option[0]));
  const chosen = preferred && allowed.has(String(preferred)) ? String(preferred) : "this_month";
  el.periodPreset.value = chosen;
  applyPeriod(chosen);
}

function readPeriod() {
  let from;
  let to;

  if (el.periodPreset.value === "custom") {
    from = el.fromDate.value;
    to = el.toDate.value;
  } else {
    const range = resolvePeriod(el.periodPreset.value);
    if (!range) {
      setStatus("اختر فترة صحيحة.", "error");
      return null;
    }
    from = range.from;
    to = range.to;
  }

  if (!from || !to) {
    setStatus("حدّد تاريخ البداية والنهاية للفترة.", "error");
    return null;
  }
  if (from > to) {
    setStatus("تاريخ البداية يجب أن يسبق تاريخ النهاية.", "error");
    return null;
  }
  return { from, to };
}

/* --------------------------- Zoho data access -------------------------- */

async function fetchAccounts() {
  const injected = await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    func: async (orgId) => {
      const response = await fetch(`/api/v3/chartofaccounts?organization_id=${orgId}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload && payload.code !== undefined && Number(payload.code) !== 0) {
        throw new Error(payload.message || `رمز الخطأ ${payload.code}`);
      }
      return (payload.chartofaccounts || []).map((account) => ({
        id: String(account.account_id),
        name: account.account_name || "",
        code: account.account_code || "",
        type: account.account_type || "",
        currency: account.currency_code || "",
        active: account.is_active !== false,
        parentId: String(account.parent_account_id || account.parent_id || ""),
        parentName: account.parent_account_name || ""
      }));
    },
    args: [state.orgId]
  });

  return (injected && injected[0] && injected[0].result) || [];
}

/* Reads the organization's base currency (used for the consolidated view). */
async function fetchBaseCurrency() {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: async (orgId) => {
        const pick = (payload) => {
          const org = payload && (payload.organization ||
            (Array.isArray(payload.organizations)
              ? payload.organizations.find((entry) => String(entry.organization_id) === String(orgId))
              : null));
          return org ? (org.currency_code || "") : "";
        };

        try {
          const response = await fetch(`/api/v3/organizations/${orgId}`, {
            headers: { Accept: "application/json" },
            credentials: "same-origin"
          });
          if (response.ok) {
            const code = pick(await response.json());
            if (code) return code.toUpperCase();
          }
        } catch (err) { /* try the list endpoint next */ }

        try {
          const response = await fetch("/api/v3/organizations", {
            headers: { Accept: "application/json" },
            credentials: "same-origin"
          });
          if (response.ok) {
            const code = pick(await response.json());
            if (code) return code.toUpperCase();
          }
        } catch (err) { /* unknown base currency */ }

        return "";
      },
      args: [state.orgId]
    });
    return (injected && injected[0] && injected[0].result) || "";
  } catch (err) {
    return "";
  }
}

/* Reads the account currently shown on the Zoho report page. */
async function detectPageContext() {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => {
        let decoded = location.href;
        try {
          decoded = decodeURIComponent(location.href);
        } catch (err) {
          /* keep the raw URL */
        }

        const accountIds = new Set();

        /* account_id= / account_id[]= / account_ids= / "account_id":"..." */
        for (const match of decoded.matchAll(/account[_-]?ids?(?:\[[^\]]*\])?["'\s]*[=:]\s*["']?(\d{8,})/gi)) {
          accountIds.add(match[1]);
        }

        /* Any long numeric token in the URL (covers rule=[{...}] JSON). */
        const urlIds = [];
        for (const match of decoded.matchAll(/\d{12,}/g)) {
          urlIds.push(match[0]);
        }

        /* The report header block around the report title is the most
           accurate description of what is currently displayed. */
        const reportTexts = [];
        let marker = null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let visited = 0;
        while (walker.nextNode() && visited < 6000) {
          visited += 1;
          const value = (walker.currentNode.nodeValue || "").trim();
          if (!value) continue;
          if (value.includes("معاملات الحساب") || /account transactions/i.test(value)) {
            marker = walker.currentNode.parentElement;
            break;
          }
        }
        if (marker) {
          let node = marker;
          for (let level = 0; level < 7 && node; level += 1) {
            const block = (node.innerText || "").trim();
            if (block.length > 20) reportTexts.push(block.slice(0, 900));
            node = node.parentElement;
          }
        }

        const titleParts = [document.title || ""];
        document.querySelectorAll("h1, h2, h3, [role=heading]").forEach((node) => {
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          if (text && text.length < 160) titleParts.push(text);
        });

        const container = document.querySelector("main, [role=main], .main-content, #main-content") || document.body;
        const bodyText = (container.innerText || "").slice(0, 4000);

        return {
          accountIds: Array.from(accountIds),
          urlIds,
          reportTexts,
          titleText: titleParts.join("\n").slice(0, 1500),
          bodyText
        };
      }
    });

    return (injected && injected[0] && injected[0].result) || {};
  } catch (err) {
    return {};
  }
}

/* Names are compared without spaces/dashes so that small formatting
   differences in Zoho do not break the match. */
function nameKey(text) {
  return normalizeSearch(text).replace(/[\s\u00A0\-–—_.]+/g, "");
}

function matchAccountsIn(text) {
  const haystack = nameKey(text || "");
  if (!haystack) return [];
  return state.accounts.filter((account) => {
    const key = nameKey(account.name);
    return key.length >= 4 && haystack.includes(key);
  });
}

function longestNameMatch(accounts) {
  return accounts.reduce((best, account) =>
    nameKey(account.name).length >= nameKey(best.name).length ? account : best, accounts[0]);
}

function matchAccountFromContext(context) {
  if (!context) return null;

  const reportTexts = Array.isArray(context.reportTexts) ? context.reportTexts : [];

  /* 1. A single account name inside the report header block. */
  for (const text of reportTexts) {
    const matches = matchAccountsIn(text);
    if (matches.length === 1) return { account: matches[0], source: "page" };
  }

  /* 2. Account id taken from the URL or from account links. */
  const ids = new Set([...(context.accountIds || []), ...(context.urlIds || [])]);
  if (ids.size > 0) {
    const matches = state.accounts.filter((account) => ids.has(account.id));
    if (matches.length === 1) return { account: matches[0], source: "url" };

    const keyed = state.accounts.filter((account) => (context.accountIds || []).includes(account.id));
    if (keyed.length === 1) return { account: keyed[0], source: "url" };
  }

  /* 3. Page title / headings. */
  const headingMatches = matchAccountsIn(context.titleText);
  if (headingMatches.length > 0) {
    return { account: longestNameMatch(headingMatches), source: "page" };
  }

  /* 4. Longest match from the report header even if it contained several names. */
  if (reportTexts.length > 0) {
    const headerMatches = matchAccountsIn(reportTexts.join("\n"));
    if (headerMatches.length > 0) {
      return { account: longestNameMatch(headerMatches), source: "page" };
    }
  }

  /* 5. A unique account name anywhere in the main content. */
  const bodyMatches = matchAccountsIn(context.bodyText);
  if (bodyMatches.length === 1) {
    return { account: bodyMatches[0], source: "page" };
  }

  return null;
}

/* Runs inside the Zoho Books tab (serialised by chrome.scripting).
   accountIds contains the selected account plus any sub-accounts to include.
   baseCurrency is the organization's base currency, used to fill base values
   when the report does not return them directly. */
async function extractInPage(orgId, accountIds, fromDate, toDate, baseCurrency) {
  const toNumber = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined || value === "") return 0;
    let text = String(value).trim();
    const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
    text = text.replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)));
    text = text.replace(/[,\s٬]/g, "").replace(/[^\d.+-]/g, "");
    const parsed = parseFloat(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const TYPE_LABELS = {
    transfer_fund: "تحويل الأموال",
    deposit: "إيداع",
    withdrawal: "سحب",
    expense: "مصروف",
    journal: "قيد يومية",
    invoice: "فاتورة",
    bill: "فاتورة مشتريات",
    customer_payment: "دفعة عميل",
    vendor_payment: "دفعة مورد",
    creditnote: "إشعار دائن",
    billpayment: "سداد فاتورة"
  };

  const idSet = new Set(accountIds.map((id) => String(id)));

  const currentYear = new Date().getFullYear();
  const isFullCurrentYear =
    fromDate === `${currentYear}-01-01` && toDate === `${currentYear}-12-31`;

  const collected = [];
  const seen = new Set();
  const seenOpenings = new Set();
  const openings = { byCurrency: {}, base: { debit: 0, credit: 0 }, fromReport: false, unallocated: { debit: 0, credit: 0 } };
  const baseCode = String(baseCurrency || "").toUpperCase();

  const isOpeningRow = (row) => {
    const type = String(row.transaction_type || "").toLowerCase();
    const label = String(row.entity_type_formatted || "").toLowerCase();
    return type === "opening_balance" ||
      type.indexOf("opening") !== -1 ||
      label.indexOf("افتتاح") !== -1 ||
      label.indexOf("opening") !== -1;
  };

  const registerOpening = (row) => {
    const code = String(row.currency_code || "").toUpperCase();
    const key = `${row.account_id || ""}|${code}|${row.date || ""}`;
    if (seenOpenings.has(key)) return;
    seenOpenings.add(key);

    const baseDebit = toNumber(row.debit);
    const baseCredit = toNumber(row.credit);
    const fcyDebit = toNumber(row.fcy_debit);
    const fcyCredit = toNumber(row.fcy_credit);

    openings.base.debit += baseDebit;
    openings.base.credit += baseCredit;
    openings.fromReport = true;

    if (code) {
      const entry = openings.byCurrency[code] || { debit: 0, credit: 0 };
      entry.debit += fcyDebit || baseDebit;
      entry.credit += fcyCredit || baseCredit;
      openings.byCurrency[code] = entry;
    } else {
      openings.unallocated.debit += fcyDebit || baseDebit;
      openings.unallocated.credit += fcyCredit || baseCredit;
    }
  };

  const fetchAccountRows = async (accountId) => {
    const rule = encodeURIComponent(JSON.stringify({
      columns: [{ index: 1, field: "account_id", value: [accountId], comparator: "in", group: "report" }],
      criteria_string: "1"
    }));

    let page = 1;
    for (let guard = 0; guard < 60; guard += 1) {
      let url = `/api/v3/reports/accounttransaction?organization_id=${orgId}` +
        `&page=${page}&per_page=500&response_option=0&rule=${rule}&usestate=false&is_new_flow=false`;

      if (isFullCurrentYear) {
        url += "&filter_by=TransactionDate.ThisYear";
      } else {
        url += "&filter_by=TransactionDate.CustomDate" +
          `&from_date=${encodeURIComponent(fromDate)}` +
          `&to_date=${encodeURIComponent(toDate)}` +
          "&is_for_date_range=true";
      }

      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`تعذّر قراءة تقرير الحساب (HTTP ${response.status}).`);

      const payload = await response.json();
      if (payload && payload.code !== undefined && Number(payload.code) !== 0) {
        throw new Error(payload.message || `تعذّر قراءة تقرير الحساب (رمز ${payload.code}).`);
      }

      const groups = (payload && payload.account_transactions) || [];
      const group = groups.find((entry) => String(entry.account_id) === String(accountId)) || groups[0];
      const batch = group && Array.isArray(group.account_transactions) ? group.account_transactions : [];

      batch.forEach((row) => {
        if (isOpeningRow(row)) {
          registerOpening(row);
          return;
        }
        const key = `${row.transaction_id}|${row.account_id}|${row.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        collected.push(row);
      });

      const hasMore = Boolean(payload && payload.page_context && payload.page_context.has_more_page);
      if (!hasMore || batch.length === 0) break;
      page += 1;
    }
  };

  for (const accountId of accountIds) {
    await fetchAccountRows(accountId);
  }

  const ownRows = collected.filter((row) => idSet.has(String(row.account_id)));

  const enrich = async (row) => {
    const rowAccountId = String(row.account_id);
    const type = row.transaction_type || "";
    let amount = 0;
    let currency = row.currency_code || "";
    let description = row.transaction_details || "";
    let reference = row.reference_number || row.entity_number || "";
    let offset = row.transaction_details || "";
    let direction = 0; /* 1 = debit, -1 = credit */
    let baseDebit = toNumber(row.debit);
    let baseCredit = toNumber(row.credit);
    let rate = toNumber(row.exchange_rate);

    const ledgerDebit = toNumber(row.fcy_debit) || toNumber(row.debit);
    const ledgerCredit = toNumber(row.fcy_credit) || toNumber(row.credit);
    if (ledgerDebit > 0) direction = 1;
    else if (ledgerCredit > 0) direction = -1;

    try {
      if (type === "transfer_fund" || type === "deposit" || type === "withdrawal") {
        const response = await fetch(
          `/api/v3/banktransactions/${row.transaction_id}?organization_id=${orgId}`,
          { headers: { Accept: "application/json" }, credentials: "same-origin" }
        );
        const payload = await response.json();
        const doc = payload && payload.banktransaction;
        if (doc) {
          amount = toNumber(doc.amount) || amount;
          currency = doc.currency_code || currency;
          description = doc.description || description;
          reference = doc.reference_number || reference;
          if (doc.from_account_id) {
            const isOutgoing = String(doc.from_account_id) === rowAccountId;
            offset = isOutgoing
              ? (doc.to_account_name || offset)
              : (doc.from_account_name || offset);
            if (!direction) direction = isOutgoing ? 1 : -1;
          } else {
            offset = doc.from_account_name || doc.to_account_name || offset;
          }
        }
      } else if (type === "expense") {
        const response = await fetch(
          `/api/v3/expenses/${row.transaction_id}?organization_id=${orgId}`,
          { headers: { Accept: "application/json" }, credentials: "same-origin" }
        );
        const payload = await response.json();
        const doc = payload && payload.expense;
        if (doc) {
          amount = toNumber(doc.amount) || amount;
          currency = doc.currency_code || currency;
          description = doc.description || description;
          reference = doc.expense_number || doc.reference_number || reference;
          offset = doc.account_name || offset;
        }
      } else if (type === "journal") {
        const response = await fetch(
          `/api/v3/journals/${row.transaction_id}?organization_id=${orgId}`,
          { headers: { Accept: "application/json" }, credentials: "same-origin" }
        );
        const payload = await response.json();
        const doc = payload && payload.journal;
        if (doc) {
          currency = doc.currency_code || currency;
          description = doc.notes || description;
          reference = doc.journal_number || doc.reference_number || reference;
          const lines = Array.isArray(doc.line_items) ? doc.line_items : [];
          const line = lines.find((entry) => String(entry.account_id) === rowAccountId);
          if (line) amount = toNumber(line.amount) || amount;
          const other = lines.find((entry) => String(entry.account_id) !== rowAccountId);
          if (other && other.account_name) offset = other.account_name;
        }
      }
    } catch (err) {
      /* keep ledger values when a source document cannot be read */
    }

    if (!amount) {
      amount = toNumber(row.fcy_debit) || toNumber(row.fcy_credit) ||
        toNumber(row.debit) || toNumber(row.credit);
    }

    if (!direction) {
      const net = String(row.net_amount || "");
      if (/dr/i.test(net)) direction = 1;
      else if (/cr/i.test(net)) direction = -1;
    }

    if (!baseDebit && !baseCredit && amount) {
      const code = String(currency || "").toUpperCase();
      let baseAmount = 0;
      if (baseCode && code === baseCode) baseAmount = amount;
      else if (rate) baseAmount = amount * rate;
      if (baseAmount) {
        if (direction === 1) baseDebit = baseAmount;
        else if (direction === -1) baseCredit = baseAmount;
      }
    }

    if (!rate && amount && (baseDebit || baseCredit)) {
      rate = (baseDebit || baseCredit) / amount;
    }

    return {
      accountId: rowAccountId,
      date: row.date_formatted || row.date || "",
      dateRaw: row.date || "",
      type: row.entity_type_formatted || TYPE_LABELS[type] || type || "معاملة",
      ref: String(reference || ""),
      offset: String(offset || ""),
      desc: String(description || ""),
      currency: String(currency || "").toUpperCase(),
      debitFCY: direction === 1 ? amount : 0,
      creditFCY: direction === -1 ? amount : 0,
      baseDebit,
      baseCredit,
      rate
    };
  };

  const enriched = new Array(ownRows.length);
  let cursor = 0;
  const workerCount = Math.min(6, ownRows.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < ownRows.length) {
      const index = cursor;
      cursor += 1;
      try {
        enriched[index] = await enrich(ownRows[index]);
      } catch (err) {
        enriched[index] = null;
      }
    }
  });

  await Promise.all(workers);

  const txns = enriched.filter(Boolean);
  txns.sort((a, b) => String(a.dateRaw).localeCompare(String(b.dateRaw)));

  const currencyCounts = new Map();
  txns.forEach((txn) => {
    if (!txn.currency) return;
    currencyCounts.set(txn.currency, (currencyCounts.get(txn.currency) || 0) + 1);
  });
  const currency = Array.from(currencyCounts.entries()).sort((a, b) => b[1] - a[1])[0];

  /* If Zoho returned an opening row without a currency and the account only
     has one currency, the base opening can safely seed that currency. */
  const distinctCurrencies = Array.from(currencyCounts.keys());
  if ((openings.unallocated.debit || openings.unallocated.credit) && distinctCurrencies.length === 1) {
    const only = distinctCurrencies[0];
    if (!baseCode || only === baseCode) {
      const entry = openings.byCurrency[only] || { debit: 0, credit: 0 };
      entry.debit += openings.unallocated.debit;
      entry.credit += openings.unallocated.credit;
      openings.byCurrency[only] = entry;
      openings.unallocated = { debit: 0, credit: 0 };
    }
  }

  const hasBase = txns.some((txn) => txn.baseDebit || txn.baseCredit) ||
    openings.base.debit > 0 || openings.base.credit > 0;

  return {
    txns,
    currency: currency ? currency[0] : "",
    baseCurrency: baseCode,
    openings,
    hasBase
  };
}

/* ---------------------------- statement build -------------------------- */

async function collectStatement(account, period, accountIds, includeChildren) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    func: extractInPage,
    args: [state.orgId, accountIds, period.from, period.to, state.baseCurrency || ""]
  });

  const extracted = injected && injected[0] ? injected[0].result : null;
  if (!extracted || !Array.isArray(extracted.txns)) {
    throw new Error("لم تُرجع Zoho أي بيانات لهذا الحساب.");
  }
  if (extracted.txns.length === 0) {
    return null;
  }

  if (includeChildren) {
    const nameById = new Map([[account.id, account.name]]);
    state.descendants.forEach((child) => nameById.set(child.id, child.name));
    extracted.txns.forEach((txn) => {
      txn.accountName = nameById.get(String(txn.accountId)) || "";
    });
  }

  const opening = extracted.openings || { byCurrency: {}, base: { debit: 0, credit: 0 } };

  return {
    accId: account.id,
    accName: account.name,
    accountCode: account.code,
    accountType: account.type,
    normalSide: DEBIT_NORMAL_TYPES.has(account.type) ? "debit" : "credit",
    currency: extracted.currency || account.currency || "",
    baseCurrency: extracted.baseCurrency || state.baseCurrency || "",
    openings: opening.byCurrency || {},
    baseOpening: opening.base || { debit: 0, credit: 0 },
    hasBase: Boolean(extracted.hasBase),
    from: period.from,
    to: period.to,
    includeChildren: Boolean(includeChildren),
    childrenCount: includeChildren ? Math.max(0, accountIds.length - 1) : 0,
    periodLabel: periodLabel(el.periodPreset.value),
    openingBalance: 0,
    generatedAt: new Date().toISOString(),
    txns: extracted.txns
  };
}

async function saveStatementData(data) {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: data });
  } catch (error) {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }
}

async function openStatement() {
  if (state.busy) return;

  if (!state.selected) {
    setStatus("اختر حساباً من القائمة أولاً.", "error");
    el.accountSearch.focus();
    openList();
    return;
  }

  const period = readPeriod();
  if (!period) return;

  setBusy("pdf", true);
  setStatus(includeChildrenSelected()
    ? "جارٍ استخراج حركات الحساب والحسابات الفرعية…"
    : "جارٍ استخراج حركات الحساب بالعملة الأصلية…");

  try {
    const accountIds = selectedAccountIds(state.selected);
    const data = await collectStatement(state.selected, period, accountIds, includeChildrenSelected());
    if (!data) {
      setStatus("لا توجد حركات مسجلة على هذا الحساب خلال الفترة المحددة.", "error");
      return;
    }

    await saveStatementData(data);
    await chrome.tabs.create({ url: chrome.runtime.getURL("statement.html") });
    hideStatus();
    window.close();
  } catch (error) {
    setStatus(friendlyError(error), "error");
  } finally {
    setBusy("pdf", false);
  }
}

/* -------------------------------- CSV ---------------------------------- */

function sanitizeFileName(value) {
  return String(value || "حساب")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "حساب";
}

function csvCell(value) {
  return `"${String(value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`;
}

function buildCsv(data) {
  const lines = [];
  const addRow = (cells) => lines.push(cells.map(csvCell).join(","));
  const withAccount = Boolean(data.includeChildren);
  const normalSide = data.normalSide === "debit" ? "debit" : "credit";
  const openings = data.openings || {};
  const txns = Array.isArray(data.txns) ? data.txns : [];
  const signed = (debit, credit) => normalSide === "credit" ? credit - debit : debit - credit;

  const currencies = [];
  txns.forEach((txn) => {
    const code = String(txn.currency || "").toUpperCase();
    if (!currencies.includes(code)) currencies.push(code);
  });
  const multi = currencies.length > 1;

  addRow(["كشف حساب", data.accName]);
  addRow(["الفترة", `${data.from} إلى ${data.to}`]);
  addRow(["العملات", currencies.map((code) => code || "غير محددة").join(" · ")]);
  if (data.baseCurrency) addRow(["العملة الأساسية", data.baseCurrency]);
  addRow(["طبيعة الرصيد", normalSide === "credit" ? "دائن" : "مدين"]);
  if (withAccount) addRow(["الحسابات الفرعية", `مضمّنة (${data.childrenCount})`]);

  if (multi && data.hasBase) {
    const baseOpen = data.baseOpening || { debit: 0, credit: 0 };
    const baseDebit = txns.reduce((sum, txn) => sum + toNumber(txn.baseDebit), 0);
    const baseCredit = txns.reduce((sum, txn) => sum + toNumber(txn.baseCredit), 0);
    const baseOpening = signed(toNumber(baseOpen.debit), toNumber(baseOpen.credit));
    const baseClosing = baseOpening + signed(baseDebit, baseCredit);

    lines.push("");
    addRow([`المركز بالعملة الأساسية (${data.baseCurrency || ""})`]);
    addRow(["الرصيد الافتتاحي", baseOpening.toFixed(2)]);
    addRow(["إجمالي المدين", baseDebit.toFixed(2)]);
    addRow(["إجمالي الدائن", baseCredit.toFixed(2)]);
    addRow(["صافي المركز", baseClosing.toFixed(2)]);
  }

  lines.push("");
  const header = ["التاريخ"];
  if (withAccount) header.push("الحساب");
  header.push("المعاملات", "التفاصيل", "الحساب المقابل", "المرجع", "العملة");
  if (multi) header.push("سعر الصرف");
  header.push("مدين", "دائن", "الرصيد");
  addRow(header);

  currencies.forEach((code) => {
    const rows = txns.filter((txn) => String(txn.currency || "").toUpperCase() === code);
    const openingEntry = openings[code] || { debit: 0, credit: 0 };
    let running = signed(toNumber(openingEntry.debit), toNumber(openingEntry.credit));
    let totalDebit = 0;
    let totalCredit = 0;

    rows.forEach((txn) => {
      const debit = toNumber(txn.debitFCY);
      const credit = toNumber(txn.creditFCY);
      totalDebit += debit;
      totalCredit += credit;
      running += signed(debit, credit);

      const row = [txn.date || ""];
      if (withAccount) row.push(txn.accountName || "");
      row.push(
        txn.type || "",
        txn.desc || "",
        txn.offset || "",
        txn.ref || "",
        code || "غير محددة"
      );
      if (multi) row.push(txn.rate ? String(txn.rate) : "");
      row.push(
        debit ? debit.toFixed(2) : "",
        credit ? credit.toFixed(2) : "",
        running.toFixed(2)
      );
      addRow(row);
    });

    const subtotal = [`إجمالي ${code || "غير محددة"}`];
    if (withAccount) subtotal.push("");
    subtotal.push("", "", "", "", "");
    if (multi) subtotal.push("");
    subtotal.push(totalDebit.toFixed(2), totalCredit.toFixed(2), running.toFixed(2));
    addRow(subtotal);
    lines.push("");
  });

  return "\uFEFF" + lines.join("\r\n");
}

async function exportCsv() {
  if (state.busy) return;

  if (!state.selected) {
    setStatus("اختر حساباً من القائمة أولاً.", "error");
    el.accountSearch.focus();
    openList();
    return;
  }

  const period = readPeriod();
  if (!period) return;

  setBusy("csv", true);
  setStatus("جارٍ تجهيز ملف CSV…");

  try {
    const includeChildren = includeChildrenSelected();
    const accountIds = selectedAccountIds(state.selected);
    const data = await collectStatement(state.selected, period, accountIds, includeChildren);
    if (!data) {
      setStatus("لا توجد حركات مسجلة على هذا الحساب خلال الفترة المحددة.", "error");
      return;
    }

    const blob = new Blob([buildCsv(data)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `كشف-حساب-${sanitizeFileName(data.accName)}-${period.from}-${period.to}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    setStatus("تم تنزيل ملف CSV بنجاح.", "success");
  } catch (error) {
    setStatus(friendlyError(error), "error");
  } finally {
    setBusy("csv", false);
  }
}

/* ------------------------------- events -------------------------------- */

el.accountSearch.addEventListener("focus", () => {
  if (state.selected) {
    el.accountSearch.select();
    return;
  }
  renderList("");
  openList();
});

el.accountSearch.addEventListener("click", () => {
  if (el.accountList.hidden) {
    renderList(state.selected ? "" : el.accountSearch.value);
    openList();
  }
});

el.accountSearch.addEventListener("input", () => {
  state.selected = null;
  state.descendants = [];
  el.clearAccount.hidden = el.accountSearch.value.length === 0;
  el.detectNote.hidden = true;
  el.childRow.hidden = true;
  el.includeChildren.checked = false;
  renderMeta(null);
  renderList(el.accountSearch.value);
  openList();
});

el.accountSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    openList();
    if (!el.accountList.hidden && state.filtered.length > 0) {
      highlightItem(state.activeIndex + 1);
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightItem(state.activeIndex - 1);
  } else if (event.key === "Enter") {
    if (!el.accountList.hidden && state.filtered.length > 0) {
      event.preventDefault();
      const index = state.activeIndex >= 0 ? state.activeIndex : 0;
      const account = state.filtered[index];
      if (account) selectAccount(account);
    }
  } else if (event.key === "Escape") {
    closeList();
  }
});

el.accountList.addEventListener("mousedown", (event) => {
  const item = event.target.closest(".combo-item");
  if (!item) return;
  event.preventDefault();
  const account = state.accounts.find((entry) => entry.id === item.dataset.id);
  if (account) selectAccount(account);
});

el.accountList.addEventListener("mousemove", (event) => {
  const item = event.target.closest(".combo-item");
  if (!item) return;
  const index = Number(item.dataset.index);
  if (Number.isNaN(index) || index === state.activeIndex) return;
  highlightItem(index);
});

el.clearAccount.addEventListener("click", clearSelection);

document.addEventListener("click", (event) => {
  if (el.combo && !el.combo.contains(event.target)) closeList();
});

el.periodPreset.addEventListener("change", () => {
  applyPeriod(el.periodPreset.value);
  savePrefs({ lastPeriod: el.periodPreset.value });
  if (el.periodPreset.value === "custom") el.fromDate.focus();
  hideStatus();
});

el.includeChildren.addEventListener("change", () => {
  state.prefs = { ...state.prefs, includeChildren: el.includeChildren.checked };
  savePrefs({ includeChildren: el.includeChildren.checked });
});

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  openStatement();
});

el.csvBtn.addEventListener("click", exportCsv);

/* -------------------------------- init --------------------------------- */

async function init() {
  try {
    const prefs = await loadPrefs();
    state.prefs = prefs;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isZohoUrl(tab.url)) {
      setStatus("افتح حسابك في Zoho Books في هذا المتصفح أولاً، ثم اضغط أيقونة الإضافة مرة أخرى.", "error");
      return;
    }

    state.tabId = tab.id;

    const match = tab.url.match(/\/app\/(\d+)/) || tab.url.match(/[?&]organization_id=(\d+)/);
    if (!match) {
      setStatus("تعذّر قراءة معرف المنشأة (Organization ID) من رابط Zoho.", "error");
      return;
    }
    state.orgId = match[1];

    setStatus("جارٍ تحميل الحسابات والتعرّف على التقرير المفتوح…");

    const [accounts, context, baseCurrency] = await Promise.all([
      fetchAccounts(),
      detectPageContext(),
      fetchBaseCurrency()
    ]);
    state.accounts = accounts;
    state.baseCurrency = baseCurrency || "";
    buildChildrenIndex();

    if (!state.accounts.length) {
      setStatus("لم يتم العثور على حسابات في هذه المنشأة.", "error");
      return;
    }

    buildPeriodOptions(prefs.lastPeriod);
    el.form.hidden = false;

    const detected = matchAccountFromContext(context);
    const lastUsed = prefs.lastAccountId
      ? state.accounts.find((account) => account.id === String(prefs.lastAccountId))
      : null;
    const chosen = (detected && detected.account) || lastUsed || state.accounts[0];

    selectAccount(chosen);

    if (detected) {
      showDetectNote(detected.source === "url"
        ? "تم التعرف على الحساب من رابط التقرير"
        : "تم التعرف على الحساب من التقرير المفتوح");
    } else if (lastUsed) {
      showDetectNote("تم اختيار آخر حساب استخدمته");
    }

    hideStatus();
  } catch (error) {
    setStatus(friendlyError(error), "error");
  }
}

init();
