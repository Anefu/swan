// budgets — helpers for the budgets part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "budgets";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

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
 * A new date `n` days after `date` (UTC days).
 * @param {Date} date
 * @param {number} n
 * @returns {Date}
 */
function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
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
 * Group items by the value of `key`.
 * @param {object[]} items
 * @param {string} key
 * @returns {Record<string, object[]>}
 */
function groupBy(items, key) {
  const out = {};
  for (const item of items) (out[item[key]] ??= []).push(item);
  return out;
}

/**
 * Change from `a` to `b` in percent of `a`.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function percentChange(a, b) {
  return ((b - a) / a) * 100;
}

/**
 * One-screen summary of budgets records for the finance dashboard: counts by status, the
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
 * Problems with one budget record before it is saved; an empty list means it is valid.
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

module.exports = { slugify, roundTo, addDays, total, maxBy, groupBy, percentChange, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
