// accounts — helpers for the accounts part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "accounts";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

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
 * Sum of `field` across `items`, ignoring missing or non-numeric values.
 * @param {object[]} items
 * @param {string} field
 * @returns {number}
 */
function total(items, field) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    const v = items[i][field];
    if (typeof v === "number") sum += v;
  }
  return sum;
}

/**
 * Keep `n` within [lo, hi].
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The item with the largest `field`, or undefined for an empty list.
 * @param {object[]} items
 * @param {string} field
 * @returns {object | undefined}
 */
function maxBy(items, field) {
  let best;
  for (const item of items) {
    if (!best || item[field] > best[field]) best = item;
  }
  return best;
}

/**
 * One page of `items`. Pages are numbered from 1.
 * @param {any[]} items
 * @param {number} page
 * @param {number} size
 * @returns {any[]}
 */
function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
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
 * One-screen summary of accounts records for the finance dashboard: counts by status, the
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
 * Problems with one account record before it is saved; an empty list means it is valid.
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

module.exports = { daysBetween, total, clamp, maxBy, paginate, taxFor, compareVersions, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
