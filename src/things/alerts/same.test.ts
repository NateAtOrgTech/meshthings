import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { areaMatches, parseSame } from "./same.js";

// 2024-05-02T21:15:00Z is day 123 of the year, matching the stamps below
const NOW = Date.UTC(2024, 4, 2, 21, 20);
const TORNADO = "ZCZC-WXR-TOR-023005+0100-1232115-KGYX/NWS-";

describe("parsing a SAME header", () => {
  test("reads every field", () => {
    const alert = parseSame(TORNADO, NOW)!;

    assert.equal(alert.originator, "WXR");
    assert.equal(alert.event, "TOR");
    assert.equal(alert.eventName, "Tornado Warning");
    assert.deepEqual(alert.areas, ["023005"]);
    assert.equal(alert.station, "KGYX/NWS");
  });

  test("reads several areas", () => {
    const alert = parseSame("ZCZC-WXR-SVR-023005-023031-033015+0045-1232115-KGYX/NWS-", NOW)!;

    assert.deepEqual(alert.areas, ["023005", "023031", "033015"]);
  });

  test("computes when the alert was issued, in UTC", () => {
    const alert = parseSame(TORNADO, NOW)!;

    assert.equal(new Date(alert.issuedAt).toISOString(), "2024-05-02T21:15:00.000Z");
  });

  test("computes expiry from the purge time", () => {
    const alert = parseSame(TORNADO, NOW)!;

    assert.equal(new Date(alert.expiresAt).toISOString(), "2024-05-02T22:15:00.000Z");
  });

  test("handles a purge time with minutes", () => {
    const alert = parseSame("ZCZC-WXR-SVR-023005+0045-1232115-KGYX/NWS-", NOW)!;

    assert.equal(alert.expiresAt - alert.issuedAt, 45 * 60 * 1000);
  });

  test("steps back a year when the stamp would land in the future", () => {
    // Read on January 1st, a header issued on day 366 belongs to last year
    const newYear = Date.UTC(2025, 0, 1, 0, 5);
    const alert = parseSame("ZCZC-WXR-TOR-023005+0100-3662350-KGYX/NWS-", newYear)!;

    assert.equal(new Date(alert.issuedAt).toISOString(), "2024-12-31T23:50:00.000Z");
    assert.ok(alert.issuedAt < newYear);
  });

  test("tolerates decoder output around the header", () => {
    const alert = parseSame(`2024-05-02 21:15:03 [INFO] ${TORNADO} (3/3)`, NOW)!;

    assert.equal(alert.event, "TOR");
  });

  test("falls back to the raw code for an unknown event", () => {
    const alert = parseSame("ZCZC-WXR-XYZ-023005+0100-1232115-KGYX/NWS-", NOW)!;

    assert.equal(alert.eventName, "XYZ");
  });
});

describe("rejecting what is not an alert", () => {
  test("ignores an end-of-message marker", () => {
    assert.equal(parseSame("NNNN", NOW), undefined);
  });

  test("ignores decoder chatter", () => {
    assert.equal(parseSame("Tuning to 162.550 MHz", NOW), undefined);
  });

  test("ignores an empty line", () => {
    assert.equal(parseSame("", NOW), undefined);
  });

  test("ignores a truncated header", () => {
    assert.equal(parseSame("ZCZC-WXR-TOR-023005", NOW), undefined);
  });

  test("ignores an impossible day of the year", () => {
    assert.equal(parseSame("ZCZC-WXR-TOR-023005+0100-9992115-KGYX/NWS-", NOW), undefined);
  });

  test("ignores an impossible time", () => {
    assert.equal(parseSame("ZCZC-WXR-TOR-023005+0100-1239999-KGYX/NWS-", NOW), undefined);
  });
});

describe("classification", () => {
  test("marks the scheduled tests", () => {
    assert.equal(parseSame("ZCZC-WXR-RWT-023005+0015-1232115-KGYX/NWS-", NOW)!.isTest, true);
    assert.equal(parseSame("ZCZC-WXR-RMT-023005+0015-1232115-KGYX/NWS-", NOW)!.isTest, true);
  });

  test("does not mark a real warning as a test", () => {
    assert.equal(parseSame(TORNADO, NOW)!.isTest, false);
  });

  test("marks life-safety events as immediate", () => {
    assert.equal(parseSame(TORNADO, NOW)!.isImmediate, true);
    assert.equal(parseSame("ZCZC-WXR-FFW-023005+0100-1232115-KGYX/NWS-", NOW)!.isImmediate, true);
  });

  test("does not mark watches and statements as immediate", () => {
    assert.equal(parseSame("ZCZC-WXR-TOA-023005+0100-1232115-KGYX/NWS-", NOW)!.isImmediate, false);
    assert.equal(parseSame("ZCZC-WXR-SPS-023005+0100-1232115-KGYX/NWS-", NOW)!.isImmediate, false);
  });
});

describe("identifying repeats", () => {
  test("gives the three bursts of one alert the same key", () => {
    const first = parseSame(TORNADO, NOW)!;
    const second = parseSame(TORNADO, NOW + 1000)!;
    const third = parseSame(TORNADO, NOW + 2000)!;

    assert.equal(first.key, second.key);
    assert.equal(second.key, third.key);
  });

  test("gives a reissue at a later time its own key", () => {
    const first = parseSame(TORNADO, NOW)!;
    const reissued = parseSame("ZCZC-WXR-TOR-023005+0100-1232215-KGYX/NWS-", NOW)!;

    assert.notEqual(first.key, reissued.key);
  });

  test("distinguishes different events for the same area", () => {
    const tornado = parseSame(TORNADO, NOW)!;
    const severe = parseSame("ZCZC-WXR-SVR-023005+0100-1232115-KGYX/NWS-", NOW)!;

    assert.notEqual(tornado.key, severe.key);
  });

  test("distinguishes different areas for the same event", () => {
    const here = parseSame(TORNADO, NOW)!;
    const there = parseSame("ZCZC-WXR-TOR-023031+0100-1232115-KGYX/NWS-", NOW)!;

    assert.notEqual(here.key, there.key);
  });
});

describe("area matching", () => {
  test("matches an exact county code", () => {
    assert.equal(areaMatches(["023005"], ["023005"]), true);
  });

  test("ignores the part-of-county digit", () => {
    // P=1 means part of the county; a subscriber to the county still wants it
    assert.equal(areaMatches(["123005"], ["023005"]), true);
    assert.equal(areaMatches(["023005"], ["123005"]), true);
  });

  test("accepts a five digit county code from a subscriber", () => {
    assert.equal(areaMatches(["023005"], ["23005"]), true);
  });

  test("matches when any one area overlaps", () => {
    assert.equal(areaMatches(["023005", "023031"], ["023031"]), true);
  });

  test("does not match a different county", () => {
    assert.equal(areaMatches(["023005"], ["023031"]), false);
  });

  test("does not match a different state with the same county digits", () => {
    assert.equal(areaMatches(["023005"], ["033005"]), false);
  });

  test("does not match an empty subscription", () => {
    assert.equal(areaMatches(["023005"], []), false);
  });
});
