// chargebacks — helpers for the chargebacks part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "chargebacks";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

/**
 * Weighted mean: sum(value * weight) / sum(weight).
 * @param {number[]} values
 * @param {number[]} weights
 * @returns {number}
 */
function weightedAverage(values, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den ? num / den : 0;
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
 * Change from `a` to `b` in percent of `a`.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function percentChange(a, b) {
  return ((b - a) / a) * 100;
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
 * Price after a percentage discount, e.g. applyDiscount(200, 25) is 150.
 * @param {number} price
 * @param {number} pct discount in percent
 * @returns {number}
 */
function applyDiscount(price, pct) {
  return price * (1 - pct / 100);
}

/**
 * Mean of a list of numbers; 0 for an empty list.
 * @param {number[]} xs
 * @returns {number}
 */
function average(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * One-screen summary of chargebacks records for the finance dashboard: counts by status, the
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
 * Problems with one chargeback record before it is saved; an empty list means it is valid.
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

module.exports = { weightedAverage, addDays, roundTo, percentChange, paginate, applyDiscount, average, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
