// Shared types for the Phaser summoning world (GachaWorldScene) and its
// React bridge (GachaVfx). Kept free of Phaser imports so it can be consumed
// by both the scene factory and the overlay UI.

export type GachaVfxPhase = "idle" | "charging" | "omen" | "burst" | "reveal" | "result";

export type GachaVfxRarity = "common" | "refined" | "rare" | "epic" | "legendary" | "mythic";

export type GachaCameraPhase =
  | "idle"
  | "opening"
  | "charging"
  | "omen"
  | "burst"
  | "reveal"
  | "result"
  | "closing";

export type CameraSnapshot = {
  scrollX: number;
  scrollY: number;
  zoom: number;
};

// Asset paths consumed by the scene. All served from the app's /public root.
export type GachaWorldAssets = {
  sky: string;
  ground: string;
  altar: string;
  halo: string;
  vortex: string;
  dragon: string;
  clouds: string;
  core: string;
  flameSheet: string;
  impactSheet: string;
  fallbackItem: string;
};

// Minimal imperative contract the React overlay uses to drive the world.
export type GachaWorldController = {
  setPhase: (phase: GachaVfxPhase, rarity?: GachaVfxRarity) => void;
  playOpenCamera: () => Promise<void>;
  playCloseCamera: () => Promise<void>;
  setResultItem: (assetKey: string | null, tier: number) => void;
  resetToIdle: () => void;
};

export type RarityTone = {
  color: number;
  rgb: [number, number, number];
};

export const RARITY_TONES: Record<GachaVfxRarity, RarityTone> = {
  common: { color: 0xa6b3af, rgb: [0.65, 0.7, 0.69] },
  refined: { color: 0x63da95, rgb: [0.39, 0.85, 0.58] },
  rare: { color: 0x61c8ff, rgb: [0.38, 0.78, 1] },
  epic: { color: 0xbd78ff, rgb: [0.74, 0.47, 1] },
  legendary: { color: 0xffc45e, rgb: [1, 0.77, 0.37] },
  mythic: { color: 0xff5965, rgb: [1, 0.35, 0.4] },
};

// Server tiers (T1..T10) mapped onto the six visual rarity bands.
// T1 common · T2 refined · T3 rare · T4 epic · T5-T6 legendary · T7+ mythic.
export function rarityForTier(tier: number): GachaVfxRarity {
  if (tier >= 7) return "mythic";
  if (tier >= 5) return "legendary";
  if (tier === 4) return "epic";
  if (tier === 3) return "rare";
  if (tier === 2) return "refined";
  return "common";
}
