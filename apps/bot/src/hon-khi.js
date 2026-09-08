import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HON_KHI_SLOTS = Object.freeze([
  "weapon",
  "offhand",
  "crown",
  "armor",
  "bracer",
  "belt",
  "boots",
  "necklace",
  "ring",
  "talisman",
  "treasure",
  "seal",
]);

const SOURCE_SLOT_BY_CANONICAL = Object.freeze({
  weapon: "weapon",
  offhand: "offhand",
  crown: "crown",
  armor: "armor",
  bracer: "bracers",
  belt: "belt",
  boots: "boots",
  necklace: "necklace",
  ring: "ring",
  talisman: "talisman",
  treasure: "relic",
  seal: "soulSeal",
});

export const HON_KHI_SLOT_LABELS = Object.freeze({
  weapon: "Vũ Khí",
  offhand: "Phó Khí",
  crown: "Hồn Quan",
  armor: "Hộ Giáp",
  bracer: "Hộ Uyển",
  belt: "Hồn Đai",
  boots: "Linh Ngoa",
  necklace: "Hồn Liên",
  ring: "Hồn Giới",
  talisman: "Hộ Phù",
  treasure: "Bí Bảo",
  seal: "Hồn Ấn",
});

export const HON_KHI_TIER_NAMES = Object.freeze({
  1: "Phàm Thiết",
  2: "Tinh Đồng",
  3: "Thanh Mộc",
  4: "Xích Viêm",
  5: "Hoàng Nham",
  6: "Bạch Kim",
  7: "Huyền Thủy",
  8: "Tinh Đấu",
  9: "Hải Thần",
  10: "Thần Vực",
});

const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL("../../gacha/src/equipment_t1_t10_manifest.json", import.meta.url),
);

export function buildHonKhiCatalog({ manifest } = {}) {
  const source =
    manifest ?? JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
  const sourceItems = source.items;
  if (!Array.isArray(sourceItems)) throw new Error("invalid_manifest_items");
  const sourceByTierSlot = new Map();
  const allowedSourceSlots = new Set(Object.values(SOURCE_SLOT_BY_CANONICAL));
  for (const item of sourceItems) {
    if (
      !Number.isInteger(item?.tier) ||
      item.tier < 1 ||
      item.tier > 10 ||
      !allowedSourceSlots.has(item?.slot)
    )
      throw new Error("invalid_manifest_item");
    const key = `${item.tier}:${item.slot}`;
    if (sourceByTierSlot.has(key))
      throw new Error(`duplicate_manifest_item:${key}`);
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 160 ||
      !Number.isFinite(item.slotBudget) ||
      item.slotBudget <= 0 ||
      typeof item.filename !== "string" ||
      !/^[A-Za-z0-9_-]+\.png$/u.test(item.filename)
    )
      throw new Error(`invalid_manifest_item:${key}`);
    sourceByTierSlot.set(key, item);
  }
  const catalog = [];

  for (let tier = 1; tier <= 10; tier += 1) {
    for (const slot of HON_KHI_SLOTS) {
      const sourceSlot = SOURCE_SLOT_BY_CANONICAL[slot];
      const sourceItem = sourceByTierSlot.get(`${tier}:${sourceSlot}`);
      if (!sourceItem)
        throw new Error(`missing_manifest_item:${tier}:${sourceSlot}`);
      const assetSlug =
        sourceItem.assetSlug ??
        sourceItem.slot.replace(
          /[A-Z]/gu,
          (value) => `-${value.toLowerCase()}`,
        );
      if (!/^[a-z0-9-]+$/u.test(assetSlug))
        throw new Error(`invalid_manifest_asset_slug:${tier}:${sourceSlot}`);
      const code = `t${tier}_${assetSlug}_base`;
      catalog.push({
        itemCode: code,
        tier,
        tierLabel: HON_KHI_TIER_NAMES[tier],
        slot,
        slotLabel: HON_KHI_SLOT_LABELS[slot],
        name: sourceItem.name,
        slotBudget: sourceItem.slotBudget,
        assetKey: `/hon-khi/tier-${String(tier).padStart(2, "0")}/${sourceItem.filename.replace(/\.png$/iu, ".webp")}`,
      });
    }
  }
  return catalog;
}
