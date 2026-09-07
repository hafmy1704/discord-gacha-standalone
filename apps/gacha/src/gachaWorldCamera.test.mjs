import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAMERA_IDLE_ZOOM,
  CAMERA_FOCUS_ZOOM,
  WORLD_PHASES,
  CAMERA_PHASES,
  phaseEnergy,
  phaseZoomPush,
  cameraZoomFor,
  isWorldPhase,
  snapshotCamera,
  restoreSnapshot,
  nextCameraPhase,
  isFocusedCameraPhase,
} from "./gachaWorldCamera.mjs";

test("every world phase exposes an energy envelope", () => {
  for (const phase of WORLD_PHASES) {
    const energy = phaseEnergy(phase);
    assert.ok(Number.isFinite(energy.intensity), `${phase} intensity`);
    assert.ok(energy.intensity >= 0, `${phase} intensity >= 0`);
    assert.ok(energy.ringAlpha >= 0 && energy.ringAlpha <= 1, `${phase} ringAlpha in range`);
    assert.ok(energy.glow >= 0 && energy.glow <= 1, `${phase} glow in range`);
  }
});

test("intensity peaks at the burst phase", () => {
  const burst = phaseEnergy("burst").intensity;
  for (const phase of WORLD_PHASES) {
    assert.ok(burst >= phaseEnergy(phase).intensity, `burst >= ${phase}`);
  }
});

test("unknown phases fall back to the idle envelope", () => {
  assert.deepEqual(phaseEnergy("bogus"), phaseEnergy("idle"));
  assert.equal(phaseZoomPush("bogus"), 0);
});

test("camera stays at idle zoom until it is focused", () => {
  for (const phase of WORLD_PHASES) {
    assert.equal(cameraZoomFor(phase, false), CAMERA_IDLE_ZOOM, `${phase} unfocused`);
  }
});

test("focused zoom monotonically escalates toward the burst", () => {
  const idle = cameraZoomFor("idle", true);
  const charging = cameraZoomFor("charging", true);
  const omen = cameraZoomFor("omen", true);
  const burst = cameraZoomFor("burst", true);
  assert.ok(idle >= CAMERA_FOCUS_ZOOM, "focus baseline");
  assert.ok(charging >= idle, "charging >= idle");
  assert.ok(omen >= charging, "omen >= charging");
  assert.ok(burst >= omen, "burst >= omen");
  assert.ok(burst > CAMERA_IDLE_ZOOM, "focused burst zoom exceeds idle zoom");
});

test("isWorldPhase guards the phase union", () => {
  assert.ok(isWorldPhase("reveal"));
  assert.ok(!isWorldPhase("opening"));
  assert.ok(!isWorldPhase(null));
});

test("snapshot round-trips the camera view exactly", () => {
  const camera = { scrollX: 128.5, scrollY: -64.25, zoom: 1.24, extra: "ignored" };
  const snap = snapshotCamera(camera);
  assert.deepEqual(snap, { scrollX: 128.5, scrollY: -64.25, zoom: 1.24 });
  assert.deepEqual(restoreSnapshot(snap), snap);
  assert.notEqual(restoreSnapshot(snap), snap, "restore returns a fresh object");
});

test("the happy-path choreography walks idle -> result -> idle", () => {
  let phase = "idle";
  phase = nextCameraPhase(phase, "open");
  assert.equal(phase, "opening");
  phase = nextCameraPhase(phase, "charge");
  assert.equal(phase, "charging");
  phase = nextCameraPhase(phase, "omen");
  assert.equal(phase, "omen");
  phase = nextCameraPhase(phase, "burst");
  assert.equal(phase, "burst");
  phase = nextCameraPhase(phase, "reveal");
  assert.equal(phase, "reveal");
  phase = nextCameraPhase(phase, "result");
  assert.equal(phase, "result");
  phase = nextCameraPhase(phase, "close");
  assert.equal(phase, "closing");
  phase = nextCameraPhase(phase, "reset");
  assert.equal(phase, "idle");
});

test("result and closing can re-open without passing through idle", () => {
  assert.equal(nextCameraPhase("result", "open"), "opening");
  assert.equal(nextCameraPhase("closing", "open"), "opening");
});

test("illegal transitions are ignored rather than throwing", () => {
  assert.equal(nextCameraPhase("idle", "burst"), "idle");
  assert.equal(nextCameraPhase("charging", "reset"), "charging");
  assert.equal(nextCameraPhase("burst", "open"), "burst");
});

test("closing tween is the only non-idle phase treated as unfocused", () => {
  for (const cameraPhase of CAMERA_PHASES) {
    const focused = isFocusedCameraPhase(cameraPhase);
    if (cameraPhase === "idle" || cameraPhase === "closing") {
      assert.equal(focused, false, `${cameraPhase} unfocused`);
    } else {
      assert.equal(focused, true, `${cameraPhase} focused`);
    }
  }
});
