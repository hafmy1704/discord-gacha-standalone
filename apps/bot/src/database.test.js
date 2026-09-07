import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "./database.js";

test("database REST calls carry a timeout signal", async () => {
  let requestSignal;
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Response("null", { status: 200 });
    },
  });

  await database.cleanupActivityLog();
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, false);
});
