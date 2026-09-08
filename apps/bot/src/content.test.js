import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessageContent, validateChatContent } from "./content.js";

test("URL-only messages are ineligible with or without a scheme", () => {
  for (const content of [
    "https://example.com/abcdefgh",
    "www.example.com/abcdefgh",
    "discord.gg/abcdefgh",
    "example.vn/duong-dan",
  ]) {
    assert.equal(normalizeMessageContent(content), "");
    assert.deepEqual(validateChatContent(content), {
      eligible: false,
      reason: "too_short",
    });
  }
});

test("normal Vietnamese conversation remains eligible", () => {
  const result = validateChatContent("Hôm nay mọi người tu luyện thế nào?");
  assert.equal(result.eligible, true);
  assert.ok(result.uniqueCharacters >= 8);
  assert.equal(result.sentenceCount, 1);
  assert.match(result.fingerprint, /^[0-9a-f]{16}$/u);
});

