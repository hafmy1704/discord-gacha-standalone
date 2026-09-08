import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SERVER_GACHA_COOLDOWN_MS,
  GACHA_ANIMATION_MS,
  GACHA_RESULT_REST_MS,
  GACHA_ROLL_CYCLE_MS,
  gachaCycleDeadline,
} from "./gachaTiming.mjs";

test("one roll keeps a half-second result rest and exceeds the server cooldown", () => {
  assert.equal(GACHA_ANIMATION_MS, 3_750);
  assert.equal(GACHA_RESULT_REST_MS, 500);
  assert.equal(GACHA_ROLL_CYCLE_MS, 4_250);
  assert.ok(GACHA_ROLL_CYCLE_MS > SERVER_GACHA_COOLDOWN_MS);
});

test("the next-roll deadline uses the shared animation-plus-rest budget", () => {
  assert.equal(gachaCycleDeadline(12_345), 16_595);
});

test("a late result still receives the full half-second rest", () => {
  assert.equal(gachaCycleDeadline(10_000, 14_500), 15_000);
});
