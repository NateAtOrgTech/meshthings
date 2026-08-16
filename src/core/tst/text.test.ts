import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { byteLength, paginate, parsePage, truncateBytes } from "../text.js";

describe("paginate", () => {
  test("keeps every page inside the byte budget", () => {
    const pages = [1, 2, 3].map((page) => paginate(["short", "x".repeat(400), "also short"], page, "more", 180));

    pages.forEach((page) => assert.ok(byteLength(page) <= 180, `page over budget: ${byteLength(page)}`));
  });

  test("keeps the paging footer readable when a line is too long for a page", () => {
    // Without clamping, send() truncates the tail and takes the footer with it,
    // so the reader never learns there are more pages
    const first = paginate(["y".repeat(400), "second entry"], 1, "services", 180);

    assert.match(first, /\(1\/2\) services 2/);
    assert.ok(byteLength(first) <= 180);
  });

  test("marks a clamped line as shortened rather than cutting it silently", () => {
    assert.match(paginate(["z".repeat(400)], 1, "more", 180), /…/);
  });

  test("leaves lines that already fit alone", () => {
    assert.equal(paginate(["one", "two"], 1, "more", 180), "one\ntwo");
  });

  test("returns nothing for an empty listing", () => {
    assert.equal(paginate([], 1, "more", 180), "");
  });

  test("clamps an out-of-range page onto the last real one", () => {
    // budget 40 leaves 12 bytes a page, so these land one per page
    const listing = ["aaaaaaaaaa", "bbbbbbbbbb"];

    assert.match(paginate(listing, 99, "more", 40), /\(2\/2\)/);
    assert.match(paginate(listing, 0, "more", 40), /\(1\/2\)/);
  });
});

describe("truncateBytes", () => {
  test("never exceeds the budget, ellipsis included", () => {
    [10, 20, 100, 180].forEach((budget) => {
      assert.ok(byteLength(truncateBytes("é".repeat(300), budget)) <= budget, `budget ${budget}`);
    });
  });

  test("does not split a multi-byte character", () => {
    assert.ok(!truncateBytes("é".repeat(300), 51).includes("�"));
  });
});

describe("parsePage", () => {
  test("falls back to page one for anything unparseable", () => {
    assert.equal(parsePage([]), 1);
    assert.equal(parsePage(["banana"]), 1);
  });
});
