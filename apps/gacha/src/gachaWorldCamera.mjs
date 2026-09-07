// Pure, framework-free choreography math for the Hồn Khí summoning world.
// Kept as plain ESM so it can be unit-tested with `node --test` without a
// TypeScript/Phaser toolchain. Types live in `gachaWorldCamera.d.mts`.

export const CAMERA_IDLE_ZOOM = 0.82;
export const CAMERA_FOCUS_ZOOM = 1.24;

export const WORLD_PHASES = [
  "idle",
  "charging",
  "omen",
  "burst",
  "reveal",
  "result",
];
export const CAMERA_PHASES = [
  "idle",
  "opening",
  "charging",
  "omen",
  "burst",
  "reveal",
  "result",
  "closing",
];

// Energy envelope driving the altar VFX intensity per phase.
const ENERGY = {
  idle: { intensity: 0.06, aperture: 0.08, ringAlpha: 0.2, glow: 0.1 },
  charging: { intensity: 0.72, aperture: 0.6, ringAlpha: 0.7, glow: 0.55 },
  omen: { intensity: 1.15, aperture: 0.95, ringAlpha: 0.9, glow: 0.8 },
  burst: { intensity: 1.7, aperture: 1.2, ringAlpha: 0.14, glow: 1 },
  reveal: { intensity: 0.72, aperture: 0.82, ringAlpha: 0.52, glow: 0.62 },
  result: { intensity: 0.18, aperture: 0.12, ringAlpha: 0.26, glow: 0.3 },
};

// Extra zoom "push" layered on top of the focus zoom for cinematic emphasis.
const ZOOM_PUSH = {
  idle: 0,
  charging: 0.02,
  omen: 0.06,
  burst: 0.12,
  reveal: 0.05,
  result: 0,
};

export function phaseEnergy(phase) {
  return ENERGY[phase] ?? ENERGY.idle;
}

export function phaseZoomPush(phase) {
  return ZOOM_PUSH[phase] ?? 0;
}

// Effective world-camera zoom for a phase given whether the camera has been
// panned in to focus on the altar.
export function cameraZoomFor(phase, focused) {
  if (!focused) return CAMERA_IDLE_ZOOM;
  return CAMERA_FOCUS_ZOOM + phaseZoomPush(phase);
}

export function isWorldPhase(value) {
  return WORLD_PHASES.includes(value);
}

export function snapshotCamera(camera) {
  return {
    scrollX: camera.scrollX,
    scrollY: camera.scrollY,
    zoom: camera.zoom,
  };
}

export function restoreSnapshot(snapshot) {
  return {
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    zoom: snapshot.zoom,
  };
}

// Explicit camera-phase state machine. Only whitelisted transitions are
// allowed; unknown events keep the current phase (never throws).
const TRANSITIONS = {
  idle: { open: "opening" },
  opening: { charge: "charging", close: "closing" },
  charging: { omen: "omen", close: "closing" },
  omen: { burst: "burst", close: "closing" },
  burst: { reveal: "reveal", close: "closing" },
  reveal: { result: "result", close: "closing" },
  result: { close: "closing", open: "opening" },
  closing: { reset: "idle", open: "opening" },
};

export function nextCameraPhase(current, event) {
  const table = TRANSITIONS[current];
  if (table && Object.prototype.hasOwnProperty.call(table, event))
    return table[event];
  return current;
}

// A camera-phase counts as "focused" whenever the camera should be zoomed
// onto the altar (everything except the resting idle and the outward tween).
export function isFocusedCameraPhase(cameraPhase) {
  return cameraPhase !== "idle" && cameraPhase !== "closing";
}
