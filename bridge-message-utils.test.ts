import assert from "node:assert/strict";
import test from "node:test";

import { appendAttachmentContext } from "./bridge-message-utils.js";

test("appendAttachmentContext keeps content unchanged without attachment context", () => {
  assert.equal(appendAttachmentContext("hello", ""), "hello");
  assert.equal(appendAttachmentContext("hello", "   "), "hello");
});

test("appendAttachmentContext returns attachment context when content is empty", () => {
  assert.equal(appendAttachmentContext("", "  [SYSTEM: Downloaded file]  "), "[SYSTEM: Downloaded file]");
});

test("appendAttachmentContext separates content and attachment context with a blank line", () => {
  assert.equal(
    appendAttachmentContext("[File attachment: report.pdf]", "[SYSTEM: Downloaded file]"),
    "[File attachment: report.pdf]\n\n[SYSTEM: Downloaded file]",
  );
});
