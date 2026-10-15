import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode } from "../packages/contracts/src/index.js";
import {
  errorGuidance,
  explainError,
  text,
} from "../apps/desktop/src/strings.js";
test("every public error has useful safe guidance and untrusted codes are never echoed", () => {
  for (const code of ErrorCode.options) {
    assert.ok(errorGuidance[code]);
    assert.ok(explainError(code).length > 30);
  }
  const hostile = "token=secret C:/Users/Alice";
  assert.equal(explainError(hostile), explainError("INTERNAL_ERROR"));
  assert.ok(!explainError(hostile).includes(hostile));
  for (const message of [
    text.bridgeError,
    text.renderError,
    explainError("INSTALL_FAILED"),
  ]) {
    assert.doesNotMatch(
      message,
      /no .*installer .*started|no application action was performed/i,
    );
    assert.match(message, /check|status/i);
  }
});
