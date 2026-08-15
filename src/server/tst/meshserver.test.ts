import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { meshServer, version } from "../meshserver.js";

// The version is read with a path relative to this file, so moving meshserver
// breaks it -- silently, since nothing else imports it and the failure only
// appears when the built output is run.
describe("version reporting", () => {
  test("resolves the project's package.json", () => {
    const expected = createRequire(import.meta.url)("../../../package.json").version;

    assert.equal(version, expected);
  });

  test("reports a real version rather than undefined", () => {
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  test("exposes start", () => {
    assert.equal(typeof meshServer.start, "function");
  });
});
