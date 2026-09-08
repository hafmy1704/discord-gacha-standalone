// Framework-free timing authority for one client-side summoning cycle.
// Types live in `gachaTiming.d.mts` so the same values can be consumed by
// React and exercised directly with `node --test`.

export const SERVER_GACHA_COOLDOWN_MS = 4_000;
export const GACHA_ANIMATION_MS = 3_750;
export const GACHA_RESULT_REST_MS = 500;
export const GACHA_ROLL_CYCLE_MS = GACHA_ANIMATION_MS + GACHA_RESULT_REST_MS;

export function gachaCycleDeadline(
  startedAt,
  resultShownAt = startedAt + GACHA_ANIMATION_MS,
) {
  return Math.max(
    startedAt + GACHA_ROLL_CYCLE_MS,
    resultShownAt + GACHA_RESULT_REST_MS,
  );
}
