import { useEffect, useRef } from "react";
import type Phaser from "phaser";
import type { GachaVfxPhase, GachaVfxRarity, GachaWorldController } from "./gachaWorldTypes";
import { GACHA_WORLD_ASSETS } from "./gachaWorldAssets";

export type { GachaVfxPhase, GachaVfxRarity, GachaWorldController } from "./gachaWorldTypes";

type GachaVfxProps = {
  phase: GachaVfxPhase;
  rarity?: GachaVfxRarity;
  onReady?: (controller: GachaWorldController) => void;
  onError?: (error: unknown) => void;
};

// Thin React <-> Phaser bridge. All world/camera/VFX logic lives inside the
// GachaWorldScene; this component only mounts the game, forwards the declarative
// `phase`/`rarity` props, and hands the imperative controller back to App.
export const GachaVfx = ({ phase, rarity, onReady, onError }: GachaVfxProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GachaWorldController | null>(null);
  const phaseRef = useRef(phase);
  const rarityRef = useRef(rarity);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  phaseRef.current = phase;
  rarityRef.current = rarity;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let game: Phaser.Game | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const mount = async () => {
      try {
        const P = await import("phaser");
        const host = hostRef.current;
        if (cancelled || !host) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const { createGachaWorldScene } = await import("./GachaWorldScene");
        const Scene = createGachaWorldScene(P, {
          reduceMotion,
          assets: GACHA_WORLD_ASSETS,
          onController: (controller) => {
            if (cancelled) return;
            controllerRef.current = controller;
            controller.setPhase(phaseRef.current, rarityRef.current);
            onReadyRef.current?.(controller);
          },
        });
        game = new P.Game({
          type: P.AUTO,
          parent: host,
          width: Math.max(1, host.clientWidth),
          height: Math.max(1, host.clientHeight),
          transparent: true,
          backgroundColor: "rgba(0,0,0,0)",
          antialias: true,
          antialiasGL: true,
          autoMobileTextures: true,
          audio: { noAudio: true },
          input: { activePointers: 0, keyboard: false, mouse: false, touch: false },
          loader: { imageLoadType: "HTMLImageElement" },
          render: {
            antialias: true,
            transparent: true,
            clearBeforeRender: true,
            powerPreference: "high-performance",
          },
          fps: { target: 60, smoothStep: true },
          scene: Scene,
        });
        resizeObserver = new ResizeObserver(([entry]) => {
          if (!entry || !game) return;
          const { width, height } = entry.contentRect;
          game.scale.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
        });
        resizeObserver.observe(host);
      } catch (error) {
        if (!cancelled) onErrorRef.current?.(error);
      }
    };

    void mount();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      controllerRef.current = null;
      game?.destroy(true);
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setPhase(phase, rarity);
  }, [phase, rarity]);

  return <div ref={hostRef} className="gacha-vfx" aria-hidden="true" />;
};
