const assert = require("node:assert");
const { sum } = require("./src/sum.js");

assert.strictEqual(sum([]), 0);
assert.strictEqual(sum([5]), 5);
assert.strictEqual(sum([1, 2, 3, 4]), 10);
console.log("all tests passed");
