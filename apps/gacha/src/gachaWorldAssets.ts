import type { GachaWorldAssets } from "./gachaWorldTypes";

// Canonical asset locations for the summoning world. Every path resolves from
// the gacha app's /public root and is bundled untouched by Vite.
export const GACHA_WORLD_ASSETS: GachaWorldAssets = {
  sky: "/ui/generated/gacha-sanctum-bg.webp",
  ground: "/ui/generated/gacha-sanctum-ground.webp",
  altar: "/ui/generated/summoning-altar.webp",
  halo: "/ui/generated/summoning-halo.webp",
  vortex: "/ui/generated/ritual-chi-vortex.webp",
  dragon: "/ui/generated/celestial-spirit-dragon.webp",
  clouds: "/ui/generated/spirit-clouds-foreground.webp",
  core: "/ui/generated/soul-prism.webp",
  flameSheet: "/ui/vfx/spirit-flame-sheet.png",
  impactSheet: "/ui/vfx/celestial-impact-sheet.png",
  fallbackItem: "/ui/generated/soul-prism.webp",
};
