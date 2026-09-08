export const SERVER_GACHA_COOLDOWN_MS: number;
export const GACHA_ANIMATION_MS: number;
export const GACHA_RESULT_REST_MS: number;
export const GACHA_ROLL_CYCLE_MS: number;

export function gachaCycleDeadline(startedAt: number, resultShownAt?: number): number;
