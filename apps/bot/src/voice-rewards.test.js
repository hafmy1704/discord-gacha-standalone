import assert from "node:assert/strict";
import test from "node:test";
import { voiceTransitionPlan } from "./voice-rewards.js";

const selected = new Set(["voice-a", "voice-b"]);

test("moving between eligible voice channels preserves the running session", () => {
  assert.deepEqual(
    voiceTransitionPlan({
      oldChannelId: "voice-a",
      newChannelId: "voice-b",
      selectedChannels: selected,
    }),
    { awardOldChannel: true, activeUpdate: null },
  );
});

test("entering and leaving eligible voice starts and settles one session", () => {
  assert.deepEqual(
    voiceTransitionPlan({
      oldChannelId: null,
      newChannelId: "voice-a",
      selectedChannels: selected,
    }),
    { awardOldChannel: false, activeUpdate: true },
  );
  assert.deepEqual(
    voiceTransitionPlan({
      oldChannelId: "voice-a",
      newChannelId: null,
      selectedChannels: selected,
    }),
    { awardOldChannel: true, activeUpdate: false },
  );
});

test("unrewarded voice channels never create a reward session", () => {
  assert.deepEqual(
    voiceTransitionPlan({
      oldChannelId: "voice-c",
      newChannelId: "voice-d",
      selectedChannels: selected,
    }),
    { awardOldChannel: false, activeUpdate: null },
  );
});
