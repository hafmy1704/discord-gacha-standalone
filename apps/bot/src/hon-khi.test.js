import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildHonKhiCatalog, HON_KHI_SLOTS } from "./hon-khi.js";

const manifestPath = fileURLToPath(
  new URL("../../gacha/src/equipment_t1_t10_manifest.json", import.meta.url),
);
test("catalog contains exactly one backed asset for every tier and slot", () => {
  const catalog = buildHonKhiCatalog();
  assert.equal(catalog.length, 120);
  assert.equal(new Set(catalog.map((item) => item.itemCode)).size, 120);

  for (let tier = 1; tier <= 10; tier += 1) {
    const tierItems = catalog.filter((item) => item.tier === tier);
    assert.deepEqual(
      tierItems.map((item) => item.slot),
      HON_KHI_SLOTS,
    );
  }

  for (const item of catalog) {
    assert.ok(Number.isFinite(item.slotBudget) && item.slotBudget > 0);
    assert.ok(
      existsSync(
        fileURLToPath(
          new URL(`../../gacha/public${item.assetKey}`, import.meta.url),
        ),
      ),
      `missing asset for ${item.itemCode}`,
    );
    assert.ok(item.assetKey.startsWith("/hon-khi/"));
  }
});

test("catalog rejects duplicate manifest authority", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.items.push({ ...manifest.items[0], name: "Duplicate authority" });
  assert.throws(
    () => buildHonKhiCatalog({ manifest }),
    /duplicate_manifest_item:1:weapon/u,
  );
});
