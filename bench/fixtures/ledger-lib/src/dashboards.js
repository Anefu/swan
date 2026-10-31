// dashboards — helpers for the dashboards part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "dashboards";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

/**
 * Round half away from zero to a number of decimals (money is rounded to cents).
 * @param {number} value
 * @param {number} [decimals=2]
 * @returns {number}
 */
function roundTo(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Compare dotted versions numerically: -1, 0 or 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Median of a list of numbers; undefined for an empty list.
 * @param {number[]} xs
 * @returns {number | undefined}
 */
function median(xs) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Whole days from `a` to `b` (negative when `b` is earlier).
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function daysBetween(a, b) {
  const MS_PER_DAY = 86400000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Distinct values, in first-seen order.
 * @param {any[]} xs
 * @returns {any[]}
 */
function unique(xs) {
  return [...new Set(xs)];
}

/**
 * Tax owed on `amount` at `rate` (0.2 is 20%), rounded to cents.
 * @param {number} amount
 * @param {number} rate
 * @returns {number}
 */
function taxFor(amount, rate) {
  return Math.round(amount * rate * 100) / 100;
}

/**
 * URL-safe slug: lowercase words joined by dashes.
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One-screen summary of dashboards records for the finance dashboard: counts by status, the
 * amount total, the largest record and a short list of overdue ids.
 * @param {{ id: string, status: string, amount: number, dueDate?: string }[]} records
 * @param {Date} [today]
 * @returns {{ count: number, byStatus: Record<string, number>, amount: number, largest?: string, overdue: string[] }}
 */
function summarize(records, today = new Date()) {
  const byStatus = {};
  let amount = 0;
  let largest;
  const overdue = [];
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (typeof r.amount === "number") amount += r.amount;
    if (!largest || r.amount > largest.amount) largest = r;
    if (r.dueDate && r.status !== "paid" && new Date(r.dueDate) < today) overdue.push(r.id);
  }
  return {
    count: records.length,
    byStatus,
    amount: Math.round(amount * 100) / 100,
    largest: largest?.id,
    overdue: overdue.slice(0, MAX_OVERDUE_LISTED),
  };
}

/**
 * Problems with one dashboard record before it is saved; an empty list means it is valid.
 * Amounts are in the record's currency, at most two decimals, and never negative except for
 * adjustments.
 * @param {{ id?: string, status?: string, amount?: number, currency?: string, kind?: string }} record
 * @returns {string[]}
 */
function validate(record) {
  const problems = [];
  if (!record || typeof record !== "object") return [`${MODULE}: record must be an object`];
  if (!record.id || typeof record.id !== "string") problems.push(`${MODULE}: id is required`);
  if (!STATUSES.includes(record.status)) problems.push(`${MODULE}: unknown status ${JSON.stringify(record.status)}`);
  if (typeof record.amount !== "number" || Number.isNaN(record.amount)) {
    problems.push(`${MODULE}: amount must be a number`);
  } else {
    if (record.amount < 0 && record.kind !== "adjustment") problems.push(`${MODULE}: amount is negative`);
    if (Math.round(record.amount * 100) !== record.amount * 100) problems.push(`${MODULE}: amount has more than two decimals`);
  }
  const currency = record.currency ?? DEFAULT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`${MODULE}: currency must be a three-letter code`);
  return problems;
}

module.exports = { roundTo, compareVersions, median, daysBetween, unique, taxFor, slugify, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
