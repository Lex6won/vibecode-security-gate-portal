import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/server.js";

test("app exports express instance", () => {
  assert.equal(typeof app, "function");
});
