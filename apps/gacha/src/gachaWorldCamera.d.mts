import type { GachaVfxPhase, GachaCameraPhase, CameraSnapshot } from "./gachaWorldTypes";

export type PhaseEnergy = {
  intensity: number;
  aperture: number;
  ringAlpha: number;
  glow: number;
};

export type CameraEvent = "open" | "charge" | "omen" | "burst" | "reveal" | "result" | "close" | "reset";

export const CAMERA_IDLE_ZOOM: number;
export const CAMERA_FOCUS_ZOOM: number;
export const WORLD_PHASES: readonly GachaVfxPhase[];
export const CAMERA_PHASES: readonly GachaCameraPhase[];

export function phaseEnergy(phase: GachaVfxPhase): PhaseEnergy;
export function phaseZoomPush(phase: GachaVfxPhase): number;
export function cameraZoomFor(phase: GachaVfxPhase, focused: boolean): number;
export function isWorldPhase(value: unknown): value is GachaVfxPhase;
export function snapshotCamera(camera: { scrollX: number; scrollY: number; zoom: number }): CameraSnapshot;
export function restoreSnapshot(snapshot: CameraSnapshot): CameraSnapshot;
export function nextCameraPhase(current: GachaCameraPhase, event: CameraEvent | string): GachaCameraPhase;
export function isFocusedCameraPhase(cameraPhase: GachaCameraPhase): boolean;
