import type Phaser from "phaser";
import {
  RARITY_TONES,
  rarityForTier,
  type GachaVfxPhase,
  type GachaVfxRarity,
  type GachaCameraPhase,
  type GachaWorldAssets,
  type GachaWorldController,
  type RarityTone,
} from "./gachaWorldTypes";
import {
  CAMERA_IDLE_ZOOM,
  cameraZoomFor,
  phaseEnergy,
  nextCameraPhase,
} from "./gachaWorldCamera.mjs";

type PhaserModule = typeof import("phaser");

export type GachaWorldSceneOptions = {
  reduceMotion: boolean;
  assets: GachaWorldAssets;
  onController: (controller: GachaWorldController) => void;
  onProgress?: (progress: number) => void;
};

const PORTAL_FRAGMENT = `
precision highp float;
uniform float uTime;
uniform float uIntensity;
uniform float uAperture;
uniform vec3 uTint;
varying vec2 outTexCoord;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
             mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), local.x), local.y);
}

void main() {
  vec2 uv = outTexCoord - 0.5;
  float radius = length(uv) * 2.0;
  float angle = atan(uv.y, uv.x);
  float edge = 1.0 - smoothstep(0.72, 1.0, radius);
  float aperture = 0.18 + uAperture * 0.18;
  float tunnel = smoothstep(aperture + 0.12, aperture, radius);
  float depth = fract(radius * 13.0 - uTime * (0.34 + uIntensity * 0.7));
  float ring = 1.0 - smoothstep(0.02, 0.16, abs(depth - 0.5));
  float spokes = pow(max(0.0, sin(angle * 12.0 + radius * 18.0 - uTime * 0.9)), 10.0);
  float grain = 0.82 + noise(vec2(angle * 3.0, radius * 11.0 - uTime * 0.2)) * 0.18;
  float energy = (ring * 0.28 + spokes * 0.14) * tunnel * edge * grain * (0.35 + uIntensity * 0.75);
  float coreGlow = exp(-radius * radius * 7.0) * (0.04 + uIntensity * 0.1);
  float alpha = clamp((energy + coreGlow) * 0.72, 0.0, 0.5);
  vec3 color = mix(vec3(0.08, 0.55, 0.5), uTint, 0.56);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export function createGachaWorldScene(
  P: PhaserModule,
  options: GachaWorldSceneOptions,
): new () => Phaser.Scene {
  const { reduceMotion, assets } = options;

  class GachaWorldScene extends P.Scene implements GachaWorldController {
    // ---- viewport + layout ---------------------------------------------
    private viewW = 1;
    private viewH = 1;
    private altarX = 0;
    private altarDisplayW = 0;
    private altarDisplayH = 0;
    private altarVisibleW = 0;
    private altarVisibleH = 0;
    private groundY = 0;
    private altarGroundY = 0;
    private altarSpriteBaseY = 0;
    private altarContent = { top: 0, bottom: 1, left: 0, right: 1 };
    private coreY = 0;
    private ringRadius = 120;
    private horizonY = 0;
    private webgl = false;

    // ---- camera choreography -------------------------------------------
    private focused = false;
    private cameraPhase: GachaCameraPhase = "idle";
    private idleCenterX = 0;
    private idleCenterY = 0;
    private idleZoom = CAMERA_IDLE_ZOOM;
    private focusCenterX = 0;
    private focusCenterY = 0;
    private camCenterX = 0;
    private camCenterY = 0;
    private camZoom = CAMERA_IDLE_ZOOM;
    private targetCenterX = 0;
    private targetCenterY = 0;
    private targetZoom = CAMERA_IDLE_ZOOM;
    private burstKick = 0;
    private savedView: { cx: number; cy: number; zoom: number } | null = null;
    private pendingTimers = new Map<number, () => void>();
    private pendingLoaderCleanups = new Set<() => void>();
    private cameraTransition = 0;
    private alive = true;

    // ---- phase / energy -------------------------------------------------
    private vfxPhase: GachaVfxPhase = "idle";
    private rarity: GachaVfxRarity = "rare";
    private phaseElapsed = 0;
    private coreAngle = 0;
    private intensity = 0.06;
    private targetIntensity = 0.06;
    private aperture = 0.08;
    private targetAperture = 0.08;
    private ringLayerAlpha = 0.2;
    private targetRingLayerAlpha = 0.2;
    private glow = 0.1;
    private targetGlow = 0.1;
    private tone: RarityTone = RARITY_TONES.rare;
    private shaderRgb: [number, number, number] = [...RARITY_TONES.rare.rgb];
    private targetShaderRgb: [number, number, number] = [...RARITY_TONES.rare.rgb];

    // ---- display objects ------------------------------------------------
    private worldLayer!: Phaser.GameObjects.Layer;
    private sky!: Phaser.GameObjects.Image;
    private skyTint!: Phaser.GameObjects.Graphics;
    private starField!: Phaser.GameObjects.Image;
    private mountainsFar!: Phaser.GameObjects.Graphics;
    private mountainsNear!: Phaser.GameObjects.Graphics;
    private fogFar!: Phaser.GameObjects.Image;
    private terrainMid!: Phaser.GameObjects.Graphics;
    private ground!: Phaser.GameObjects.Image;
    private horizonBlend!: Phaser.GameObjects.Image;
    private platform!: Phaser.GameObjects.Graphics;
    private groundGlow!: Phaser.GameObjects.Graphics;
    private perspective!: Phaser.GameObjects.Graphics;
    private foreVignette!: Phaser.GameObjects.Graphics;
    private altarShadow!: Phaser.GameObjects.Image;
    private altarCast!: Phaser.GameObjects.Image;
    private halo!: Phaser.GameObjects.Image;
    private portalShader?: Phaser.GameObjects.Shader;
    private vortexBack!: Phaser.GameObjects.Image;
    private vortexFront!: Phaser.GameObjects.Image;
    private rings: Phaser.GameObjects.Graphics[] = [];
    private runes!: Phaser.GameObjects.Graphics;
    private spiritDragon!: Phaser.GameObjects.Image;
    private altar!: Phaser.GameObjects.Image;
    private core!: Phaser.GameObjects.Image;
    private clouds!: Phaser.GameObjects.Image;
    private cloudsBack: Phaser.GameObjects.Image[] = [];
    private cloudsFore: Phaser.GameObjects.Image[] = [];
    private flameSprites: Phaser.GameObjects.Image[] = [];
    private flameFrameKeys: string[] = [];
    private orbitStars: Phaser.GameObjects.Image[] = [];
    private depthMotes: Phaser.GameObjects.Image[] = [];
    private resultItem!: Phaser.GameObjects.Image;
    private resultItemActive = false;

    // ---- emitters -------------------------------------------------------
    private convergenceEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private ringEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private burstEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private impactSprite?: Phaser.GameObjects.Image;
    private impactFrameKeys: string[] = [];
    private impactElapsed = 0;
    private impactFrame = -1;
    private bloom?: Phaser.Filters.ParallelFilters;

    // ---- screen-space UI camera ----------------------------------------
    private uiCamera!: Phaser.Cameras.Scene2D.Camera;
    private vignette!: Phaser.GameObjects.Image;
    private flashRect!: Phaser.GameObjects.Rectangle;

    constructor() {
      super({ key: "gacha-world" });
    }

    preload() {
      if (options.onProgress) {
        this.load.on("progress", options.onProgress);
        this.load.once("complete", () => options.onProgress!(1));
      }
      this.load.image("world-sky", assets.sky);
      this.load.image("world-ground", assets.ground);
      this.load.image("world-altar", assets.altar);
      this.load.image("world-halo", assets.halo);
      this.load.image("world-vortex", assets.vortex);
      this.load.image("world-dragon", assets.dragon);
      this.load.image("world-clouds", assets.clouds);
      this.load.image("world-core", assets.core);
      this.load.spritesheet("world-flame", assets.flameSheet, { frameWidth: 256, frameHeight: 256 });
      this.load.spritesheet("world-impact", assets.impactSheet, { frameWidth: 256, frameHeight: 256 });
    }

    create() {
      this.webgl = this.renderer.type === P.WEBGL;
      this.makeProceduralTextures();
      this.makeSoftImageTexture("world-clouds", "world-clouds-soft");
      this.makeSoftImageTexture("world-halo", "world-halo-soft");
      this.makeSoftImageTexture("world-vortex", "world-vortex-soft");
this.makeSoftImageTexture("world-dragon", "world-dragon-soft");
      this.makeSoftImageTexture("world-core", "world-core-soft");
      this.flameFrameKeys = this.makeSoftFrameTextures("world-flame", "world-soft-flame");
      this.impactFrameKeys = this.makeSoftFrameTextures("world-impact", "world-soft-impact");

      this.worldLayer = this.add.layer();

      this.altarContent = this.computeContentBounds("world-altar");
      this.buildWorld();
      this.buildAltar();
      this.buildVfx();
      this.buildScreenSpace();

      this.scale.on("resize", (size: { width: number; height: number }) => this.layout(size.width, size.height));
      this.layout(this.scale.width, this.scale.height);

      // Snap the live camera onto the freshly computed idle framing.
      this.camCenterX = this.idleCenterX;
      this.camCenterY = this.idleCenterY;
      this.camZoom = this.idleZoom;
      this.cameras.main.setZoom(this.camZoom).centerOn(this.camCenterX, this.camCenterY);

      this.events.once(P.Scenes.Events.SHUTDOWN, () => this.teardown());
      this.events.once(P.Scenes.Events.DESTROY, () => this.teardown());

      options.onController(this);
      this.setPhase(this.vfxPhase, this.rarity);
    }

    private world<T extends Phaser.GameObjects.GameObject>(object: T): T {
      this.worldLayer.add(object);
      return object;
    }

    // =====================================================================
    // World layers (single backdrop -> atmosphere -> altar -> foreground)
    // =====================================================================
    private buildWorld() {
      this.sky = this.world(
        this.add.image(0, 0, "world-sky").setOrigin(0.5).setScrollFactor(0.04).setAlpha(0.68).setDepth(0),
      );
      this.skyTint = this.world(this.add.graphics().setScrollFactor(0.04).setDepth(0.5));
      this.starField = this.world(
        this.add.image(0, 0, "world-stars").setOrigin(0.5).setBlendMode(P.BlendModes.ADD).setScrollFactor(0.06).setAlpha(0.5).setDepth(1),
      );
      this.mountainsFar = this.world(this.add.graphics().setScrollFactor(0.14).setDepth(2));
      this.mountainsNear = this.world(this.add.graphics().setScrollFactor(0.24).setDepth(3));
      this.fogFar = this.world(
        this.add.image(0, 0, "world-fog").setOrigin(0.5).setBlendMode(P.BlendModes.SCREEN).setScrollFactor(0.2).setAlpha(0.1).setDepth(4),
      );
      this.terrainMid = this.world(this.add.graphics().setScrollFactor(0.5).setDepth(5));
      this.ground = this.world(
        // Overlap the ground plate with the background floor to hide the horizon seam.
        this.add.image(0, 0, "world-ground").setOrigin(0.5, 1).setScrollFactor(0.82).setAlpha(1).setDepth(6),
      );
      // Vertical gradient that feathers the ground's top edge into the horizon,
      // removing the hard colour seam across the mid-screen.
      // Distant drifting clouds behind the altar (parallax depth).
      this.cloudsBack = [0, 1, 2].map((index) =>
        this.world(
          this.add
            .image(0, 0, "world-cloud")
            .setOrigin(0.5)
            .setBlendMode(P.BlendModes.SCREEN)
            .setScrollFactor(0.16 + index * 0.05)
            .setAlpha(0.16 + index * 0.05)
            .setDepth(2.4 + index * 0.05),
        ),
      );
      this.horizonBlend = this.world(
        this.add.image(0, 0, "world-hgrad").setOrigin(0.5, 0.5).setScrollFactor(0.5).setAlpha(0.96).setDepth(6.1),
      );
      this.platform = this.world(this.add.graphics().setScrollFactor(0.82).setDepth(6.2));
      this.groundGlow = this.world(this.add.graphics().setBlendMode(P.BlendModes.ADD).setScrollFactor(0.82).setDepth(6.4));
      this.perspective = this.world(this.add.graphics().setBlendMode(P.BlendModes.ADD).setScrollFactor(0.82).setDepth(6.6));

      this.world(
        this.add.particles(0, 0, "world-soft", {
          x: () => (Math.random() - 0.5) * this.viewW * 1.3 + this.viewW * 0.5,
          y: () => Math.random() * this.viewH,
          lifespan: { min: 4200, max: 8200 },
          speedY: { min: -12, max: -3 },
          speedX: { min: -6, max: 6 },
          scale: { start: 0.05, end: 0 },
          alpha: { start: 0.2, end: 0 },
          tint: [0x6de9d2, 0x87cfff, 0xecc879],
          frequency: reduceMotion ? 520 : 190,
          maxAliveParticles: reduceMotion ? 22 : 54,
          blendMode: P.BlendModes.ADD,
        }).setScrollFactor(0.6).setDepth(5.5),
      );
    }

    private buildAltar() {
      // Soft contact shadow (ambient occlusion) hugging the altar's foot on the dais.
      this.altarCast = this.world(
        this.add.image(0, 0, "world-soft").setBlendMode(P.BlendModes.MULTIPLY).setTint(0x02060a).setScrollFactor(1).setAlpha(0).setVisible(false).setDepth(6.7),
      );
      this.altarShadow = this.world(
        this.add.image(0, 0, "world-soft").setBlendMode(P.BlendModes.MULTIPLY).setTint(0x01050a).setScrollFactor(1).setAlpha(0.55).setDepth(11.9),
      );
      this.halo = this.world(
        this.add.image(0, 0, "world-halo-soft").setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setAlpha(0.5).setVisible(false).setDepth(8),
      );

      if (this.webgl) {
        this.portalShader = this.world(
          this.add
            .shader(
              {
                name: "cultivationPortal",
                fragmentSource: PORTAL_FRAGMENT,
                setupUniforms: (setUniform: (name: string, value: number | number[]) => void) => {
                  setUniform("uTime", this.game.loop.time / 1000);
                  setUniform("uIntensity", this.intensity);
                  setUniform("uAperture", this.aperture);
                  setUniform("uTint", this.shaderRgb);
                },
              },
              0,
              0,
              420,
              420,
            )
            .setBlendMode(P.BlendModes.ADD)
            .setScrollFactor(1)
            .setDepth(9),
        );
      }

      this.vortexBack = this.world(
        this.add.image(0, 0, "world-vortex-soft").setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setAlpha(0).setVisible(false).setDepth(9.5),
      );
      this.rings = [0, 1, 2, 3].map((index) =>
        this.world(this.add.graphics().setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setAlpha(0.08).setDepth(10 + index * 0.05)),
      );
      this.runes = this.world(this.add.graphics().setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setDepth(10.4));

      this.convergenceEmitter = this.world(
        this.add.particles(0, 0, "world-streak", {
          emitting: false,
          lifespan: { min: 520, max: 940 },
          speed: 0,
          moveToX: () => this.altarX,
          moveToY: () => this.coreY,
          scaleX: { start: 0.4, end: 0.03 },
          scaleY: { start: 0.24, end: 0.02 },
          alpha: { start: 0.74, end: 0 },
          rotate: { min: 0, max: 360 },
          frequency: reduceMotion ? 80 : 34,
          quantity: reduceMotion ? 1 : 2,
          maxAliveParticles: reduceMotion ? 34 : 108,
          blendMode: P.BlendModes.ADD,
        }).setScrollFactor(1).setDepth(10.6),
      );

      this.ringEmitter = this.world(
        this.add.particles(0, 0, "world-soft", {
          emitting: true,
          lifespan: { min: 650, max: 1200 },
          speed: { min: 4, max: 22 },
          scale: { start: 0.09, end: 0.015 },
          alpha: { start: 0.6, end: 0 },
          frequency: reduceMotion ? 220 : 130,
          maxAliveParticles: reduceMotion ? 26 : 68,
          blendMode: P.BlendModes.ADD,
        }).setScrollFactor(1).setAlpha(0.3).setDepth(10.8),
      );

      this.spiritDragon = this.world(
        this.add.image(0, 0, "world-dragon-soft").setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setAlpha(0).setVisible(false).setDepth(11),
      );
      this.altar = this.world(
        this.add.image(0, 0, "world-altar").setOrigin(0.5, 1).setScrollFactor(1).setDepth(12),
      );
      this.core = this.world(
        this.add.image(0, 0, "world-core-soft").setScrollFactor(1).setAlpha(0.9).setDepth(13),
      );

      if (this.textures.exists("world-flame")) {
        this.flameSprites = Array.from({ length: reduceMotion ? 3 : 7 }, () =>
          this.world(
            this.add
              .image(0, 0, this.flameFrameKeys[0] ?? "world-flame")
              .setBlendMode(P.BlendModes.SCREEN)
              .setScrollFactor(1)
              .setAlpha(0.08)
              .setDepth(13.5),
          ),
        );
      }

      this.vortexFront = this.world(
        this.add.image(0, 0, "world-vortex-soft").setBlendMode(P.BlendModes.ADD).setFlipX(true).setScrollFactor(1).setAlpha(0).setVisible(false).setDepth(14),
      );
    }

    private buildVfx() {
      this.orbitStars = Array.from({ length: reduceMotion ? 4 : 10 }, (_, index) =>
        this.world(
          this.add.image(0, 0, "world-star").setBlendMode(P.BlendModes.ADD).setScrollFactor(1).setAlpha(0.08 + (index % 3) * 0.02).setDepth(11.5),
        ),
      );
      this.depthMotes = Array.from({ length: reduceMotion ? 5 : 14 }, (_, index) =>
        this.world(
          this.add
            .image(0, 0, "world-soft")
            .setBlendMode(P.BlendModes.SCREEN)
            .setScrollFactor(0.7 + (index % 4) * 0.08)
            .setTint(index % 3 === 0 ? 0x9df8e1 : index % 3 === 1 ? 0x78c9ff : 0xf0cf8a)
            .setAlpha(0.035 + (index % 4) * 0.012)
            .setDepth(5.2 + (index % 5) * 0.05),
        ),
      );

      this.burstEmitter = this.world(
        this.add.particles(0, 0, "world-streak", {
          emitting: false,
          lifespan: { min: 430, max: 980 },
          speed: { min: 260, max: 760 },
          angle: { min: 0, max: 360 },
          scaleX: { start: 1.15, end: 0.03 },
          scaleY: { start: 0.55, end: 0.04 },
          alpha: { start: 1, end: 0 },
          rotate: { min: 0, max: 360 },
          maxParticles: reduceMotion ? 80 : 300,
          blendMode: P.BlendModes.ADD,
        }).setScrollFactor(1).setDepth(20),
      );
      this.burstEmitter.reserve(reduceMotion ? 70 : 250);

      if (this.textures.exists("world-impact")) {
        this.impactSprite = this.world(
          this.add
            .image(0, 0, this.impactFrameKeys[0] ?? "world-impact")
            .setBlendMode(P.BlendModes.SCREEN)
            .setScrollFactor(1)
            .setVisible(false)
            .setDepth(21),
        );
      }

      this.resultItem = this.world(
        this.add.image(0, 0, "world-core-soft").setScrollFactor(1).setAlpha(0).setDepth(22),
      );

      this.clouds = this.world(
        this.add.image(0, 0, "world-clouds-soft").setOrigin(0.5, 1).setBlendMode(P.BlendModes.SCREEN).setScrollFactor(1.12).setAlpha(0.56).setDepth(25),
      );
      // Extra low-lying foreground mist drifting across the base.
      this.cloudsFore = [0, 1].map((index) =>
        this.world(
          this.add
            .image(0, 0, "world-cloud")
            .setOrigin(0.5)
            .setBlendMode(P.BlendModes.SCREEN)
            .setScrollFactor(1.2 + index * 0.12)
            .setAlpha(0.09 + index * 0.04)
            .setDepth(24 + index * 0.4),
        ),
      );
      this.world(
        this.add.particles(0, 0, "world-cloud", {
          x: () => (Math.random() - 0.5) * this.viewW * 1.2 + this.altarX,
          y: () => this.viewH * (0.86 + Math.random() * 0.12),
          lifespan: { min: 6000, max: 11000 },
          speedX: { min: -10, max: 10 },
          speedY: { min: -4, max: -1 },
          scale: { start: 0.5, end: 0.95 },
          alpha: { start: 0.14, end: 0 },
          tint: [0x9fdccb, 0x7fb6c9],
          frequency: reduceMotion ? 1600 : 700,
          maxAliveParticles: reduceMotion ? 4 : 10,
          blendMode: P.BlendModes.SCREEN,
        }).setScrollFactor(1.16).setDepth(24.5),
      );
      this.foreVignette = this.world(this.add.graphics().setScrollFactor(1.2).setDepth(26));

      if (this.webgl && !reduceMotion) {
        const bloom = P.Actions.AddEffectBloom(this.cameras.main, {
          threshold: 0.66,
          blurRadius: 2,
          blurSteps: 2,
          blurQuality: 1,
          blendAmount: 0.62,
          blendMode: P.BlendModes.ADD,
          useInternal: true,
        });
        this.bloom = bloom[0]?.parallelFilters;
        if (this.bloom) this.bloom.active = false;
      }
    }

    private buildScreenSpace() {
      this.vignette = this.add.image(0, 0, "world-vignette").setOrigin(0).setScrollFactor(0).setDepth(40).setVisible(false);
      this.flashRect = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0xffffff, 0).setOrigin(0).setBlendMode(P.BlendModes.ADD).setScrollFactor(0).setDepth(41);

      this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height);
      this.uiCamera.setScroll(0, 0).setZoom(1);
      this.uiCamera.transparent = true;
      // World camera never renders the screen-space overlays and vice versa.
      this.cameras.main.ignore([this.vignette, this.flashRect]);
      this.uiCamera.ignore(this.worldLayer);
    }

    // =====================================================================
    // Layout (responsive, recomputed on every resize)
    // =====================================================================
    private layout(width: number, height: number) {
      this.viewW = Math.max(1, width);
      this.viewH = Math.max(1, height);
      const small = width < 620;
      const short = height < 520;
      const centerX = width * 0.5;
      this.horizonY = height * 0.35;
      this.altarX = width * (small ? 0.5 : 0.54);
      // Ground contact line — the visible altar base stands here.
      this.groundY = height * (short ? 0.86 : small ? 0.82 : 0.78);

      const coverW = (width / CAMERA_IDLE_ZOOM) * 1.4;
      const coverH = (height / CAMERA_IDLE_ZOOM) * 1.4;

      // Keep the complete source image visible so its horizon and floor remain one continuous backdrop.
      this.sky.setPosition(centerX, this.horizonY * 0.46).setDisplaySize(coverW, coverH * 0.92);
      this.starField.setPosition(centerX, this.horizonY * 0.5).setDisplaySize(coverW, coverH * 0.6);
      this.drawSkyTint(centerX, coverW, coverH);
      this.drawMountains(width, height, centerX);

      this.fogFar.setPosition(centerX, this.horizonY).setDisplaySize(coverW, height * 0.28);
      this.drawTerrain(width, height, centerX);

      const groundAspect = this.ground.height / this.ground.width; // ~0.25 (wide floor plate)
      const groundW = Math.max(coverW, (height * 0.66) / groundAspect);
      const groundH = groundW * groundAspect;
      // Start the reflective plate a little below the background's own horizon so
      // the two images overlap in the dim mid-ground; a wide haze dissolves the join.
      const groundTop = this.horizonY - height * 0.015;
      this.ground.setPosition(centerX, groundTop + groundH).setDisplaySize(groundW, groundH);
      this.horizonBlend.setPosition(centerX, groundTop).setDisplaySize(coverW * 1.1, height * 0.48);

      // Altar sizing/grounding uses the real alpha bounds of the square art so
      // the visible pedestal sits exactly on the ground (no transparent-pad float).
      const content = this.altarContent;
      const contentH = Math.max(0.001, content.bottom - content.top);
      const contentW = Math.max(0.001, content.right - content.left);
      const altarAspect = this.altar.height / this.altar.width; // ~1 (square art)
      const visWMax = Math.min(width * (small ? 0.66 : 0.44), small ? 460 : 600);
      const visHMax = height * (short ? 0.54 : small ? 0.6 : 0.64);
      // Sprite side length constrained by both visible width and visible height.
      const side = Math.min(visWMax / contentW, visHMax / (contentH * altarAspect));
      this.altarDisplayW = side;
      this.altarDisplayH = side * altarAspect;
      this.altarVisibleW = side * contentW;
      this.altarVisibleH = this.altarDisplayH * contentH;
      this.ringRadius = this.altarVisibleW * 0.48;
      // Altar stands a touch nearer the viewer, seated in the middle of the ring.
      this.altarGroundY = this.groundY + this.ringRadius * 0.16;
      this.coreY = this.altarGroundY - this.altarVisibleH * 0.62;

      // Origin (0.5,1): shift the sprite down by its bottom transparent padding
      // so the visible base lands on the altar world position.
      const spriteBaseY = this.altarGroundY + this.altarDisplayH * (1 - content.bottom);
      this.altarSpriteBaseY = spriteBaseY;
      this.altar.setPosition(this.altarX, spriteBaseY).setDisplaySize(this.altarDisplayW, this.altarDisplayH);
      // Mirrored, flattened silhouette reflected onto the glossy floor = shadow.
      this.altarCast
        .setPosition(this.altarX, this.altarGroundY - this.altarDisplayH * (1 - content.bottom) * 0.42)
        .setDisplaySize(this.altarDisplayW * 0.98, this.altarDisplayH * 0.42);
      this.altarShadow
        .setPosition(this.altarX, this.altarGroundY)
        .setDisplaySize(this.altarVisibleW * 1.02, this.altarVisibleH * 0.16);

      const spiritSize = this.ringRadius * 2.72;
      this.halo.setPosition(this.altarX, this.coreY - this.ringRadius * 0.16).setDisplaySize(spiritSize * 1.14, spiritSize * 1.14);
      this.portalShader?.setPosition(this.altarX, this.coreY).setDisplaySize(spiritSize * 1.18, spiritSize * 1.18);
      this.vortexBack.setPosition(this.altarX, this.coreY).setDisplaySize(spiritSize * 1.16, spiritSize * 1.16);
      this.vortexFront.setPosition(this.altarX, this.coreY).setDisplaySize(spiritSize, spiritSize);
      this.spiritDragon.setPosition(this.altarX, this.coreY - this.ringRadius * 0.1).setDisplaySize(spiritSize * 1.04, spiritSize * 1.04);
      this.core.setPosition(this.altarX, this.coreY).setDisplaySize(this.ringRadius * 0.92, this.ringRadius * 0.92);
      this.impactSprite?.setPosition(this.altarX, this.coreY).setDisplaySize(spiritSize * 1.5, spiritSize * 1.5);
      if (!this.resultItemActive) this.resultItem.setPosition(this.altarX, this.coreY);

      this.clouds.setPosition(centerX, height * 1.08).setDisplaySize(coverW * 1.34, height * 0.52);
      // Cloud-layer sizes (positions are animated for drift in update()).
      this.cloudsBack.forEach((cloud, index) => cloud.setDisplaySize(width * (0.8 + index * 0.3), height * (0.36 + index * 0.06)));
      this.cloudsFore.forEach((cloud, index) => cloud.setDisplaySize(width * (1 + index * 0.35), height * (0.3 + index * 0.08)));

      this.drawPlatform();
      this.drawRings();
      this.drawRunes();
      this.drawGroundGlow();
      this.drawPerspective();
      this.drawForeVignette(width, height);
      this.updateEmitterZones();
      this.layoutFlames();
      this.layoutMotes(width, height);

      // Screen-space overlays fill the viewport regardless of world zoom.
      this.vignette.setPosition(0, 0).setDisplaySize(width, height);
      this.flashRect.setPosition(0, 0).setSize(width, height);
      this.uiCamera.setSize(width, height);
      this.cameras.main.setSize(width, height);

      // Camera framing targets. Idle frames the whole world; focus centres the
      // altar with a little headroom above the rising core.
      this.idleCenterX = centerX;
      this.idleCenterY = this.groundY - this.altarVisibleH * 0.34;
      this.idleZoom = CAMERA_IDLE_ZOOM;
      this.focusCenterX = this.altarX;
      this.focusCenterY = this.coreY + this.ringRadius * 0.2;
      this.recomputeCameraTargets();
    }

    private drawSkyTint(centerX: number, coverW: number, coverH: number) {
      const g = this.skyTint.clear();
      g.fillStyle(0x040d14, 0.28).fillRect(centerX - coverW * 0.5, this.horizonY * 0.62 - coverH * 0.4, coverW, coverH * 0.8);
    }

    private drawMountains(width: number, height: number, centerX: number) {
      const build = (
        g: Phaser.GameObjects.Graphics,
        color: number,
        alpha: number,
        base: number,
        amp: number,
        step: number,
        seed: number,
      ) => {
        g.clear().fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(centerX - width, height);
        for (let x = -width; x <= width * 2; x += step) {
          const n = Math.sin(x * 0.011 + seed) * 0.6 + Math.sin(x * 0.027 + seed * 2.1) * 0.4;
          g.lineTo(centerX * 0 + x, base + n * amp);
        }
        g.lineTo(centerX + width * 2, height);
        g.closePath();
        g.fillPath();
      };
      build(this.mountainsFar, 0x0c2733, 0.62, this.horizonY - height * 0.02, height * 0.09, width < 620 ? 26 : 40, 3.7);
      build(this.mountainsNear, 0x081c26, 0.8, this.horizonY + height * 0.03, height * 0.07, width < 620 ? 22 : 32, 8.2);
    }

    private drawTerrain(width: number, height: number, centerX: number) {
      const g = this.terrainMid.clear();
      const top = this.horizonY;
      const bottom = height * 1.02;
      g.fillStyle(0x05141a, 0.85).fillRect(centerX - width, top, width * 3, bottom - top);
    }

    // Raised circular dais with a visible vertical wall so the altar sits fully
    // on an elevated pedestal (real high/low depth) rather than a flat decal.
    private drawPlatform() {
      const g = this.platform.clear();
      const cx = this.altarX;
      const rw = this.altarVisibleW * 0.68;
      const rhTop = rw * 0.33;
      const wallH = this.altarVisibleW * 0.34;
      const topY = this.altarGroundY;
      const botY = topY + wallH;

      // Ambient contact shadow on the floor around the dais foot.
      g.fillStyle(0x02060a, 0.5).fillEllipse(cx, botY + rhTop * 0.5, rw * 1.4, rhTop * 1.5);

      // Bottom cap.
      g.fillStyle(0x061419, 1).fillEllipse(cx, botY, rw, rhTop);

      // Vertical front wall (gives the pedestal its height).
      g.fillStyle(0x0d272c, 1).fillRect(cx - rw, topY, rw * 2, wallH);
      g.fillStyle(0x07161b, 0.6).fillRect(cx - rw, topY + wallH * 0.5, rw * 2, wallH * 0.5);
      // Glowing energy band + tier-tinted light around the wall.
      g.fillStyle(this.tone.color, 0.16).fillRect(cx - rw, topY + wallH * 0.4, rw * 2, wallH * 0.16);
      g.fillStyle(0x5ff0d6, 0.1).fillRect(cx - rw, topY + wallH * 0.24, rw * 2, wallH * 0.06);
      // Side edge highlights.
      g.lineStyle(2.4, 0x4fe0c6, 0.42);
      g.beginPath(); g.moveTo(cx - rw, topY); g.lineTo(cx - rw, botY); g.strokePath();
      g.beginPath(); g.moveTo(cx + rw, topY); g.lineTo(cx + rw, botY); g.strokePath();

      // Bottom cap front lip (curved base).
      g.lineStyle(2, 0x2a5a5a, 0.5).strokeEllipse(cx, botY, rw, rhTop);

      // Top surface — the green magic disc the altar stands on.
      g.fillStyle(0x0a2228, 1).fillEllipse(cx, topY, rw, rhTop);
      g.fillStyle(0x143a3e, 0.95).fillEllipse(cx, topY, rw * 0.9, rhTop * 0.9);
      g.fillStyle(0x1c5054, 0.5).fillEllipse(cx, topY, rw * 0.58, rhTop * 0.58);
      g.lineStyle(2.8, 0x5ff0d6, 0.72).strokeEllipse(cx, topY, rw, rhTop);
      g.lineStyle(1.6, 0xffe0a0, 0.4).strokeEllipse(cx, topY, rw * 0.72, rhTop * 0.72);
      g.lineStyle(1.2, 0x8ff0dc, 0.4).strokeEllipse(cx, topY, rw * 0.44, rhTop * 0.44);
    }

    private drawGroundGlow() {
      const g = this.groundGlow.clear();
      g.fillStyle(0x2fb9a6, 0.16);
      g.fillEllipse(this.altarX, this.altarGroundY, this.ringRadius * 3.2, this.ringRadius * 0.98);
      g.fillStyle(0x63f0d4, 0.08);
      g.fillEllipse(this.altarX, this.altarGroundY, this.ringRadius * 1.6, this.ringRadius * 0.5);
    }

    private drawPerspective() {
      const g = this.perspective.clear();
      const vanishX = this.altarX;
      const vanishY = this.altarGroundY - this.altarVisibleH * 0.05;
      const baseY = this.viewH * 1.06;
      const lanes = 9;
      g.lineStyle(1.4, 0x39c9b6, 0.12);
      for (let i = 0; i <= lanes; i += 1) {
        const t = i / lanes;
        const spread = (t - 0.5) * this.viewW * 2.4;
        g.beginPath();
        g.moveTo(vanishX, vanishY);
        g.lineTo(vanishX + spread, baseY);
        g.strokePath();
      }
      // Concentric depth arcs radiating from the platform across the floor.
      g.lineStyle(1, 0x7befd6, 0.12);
      for (let r = 1; r <= 4; r += 1) {
        const ry = this.ringRadius * (1.1 + r * 0.7);
        g.strokeEllipse(this.altarX, this.altarGroundY + ry * 0.14, ry * 2.4, ry * 0.82);
      }
    }

    private drawForeVignette(_width: number, height: number) {
      // Near-field haze gives the floor a real depth falloff under the cloud bank.
      const g = this.foreVignette.clear();
      g.fillGradientStyle(0x06151b, 0x06151b, 0x02070c, 0x02070c, 0.02, 0.02, 0.34, 0.34);
      g.fillRect(0, height * 0.72, this.viewW, height * 0.28);
    }

    private drawRings() {
      const colors = [0x6af1d4, 0xf4c873, 0x78c9ff, 0xa9ffe9];
      this.rings.forEach((ring, index) => {
        const radius = this.ringRadius * (0.58 + index * 0.155);
        ring.clear().setPosition(this.altarX, this.coreY).lineStyle(index === 1 ? 1.1 : 0.62, colors[index]!, 0.58);
        const segments = 8 + index * 4;
        for (let segment = 0; segment < segments; segment += 1) {
          const start = (segment / segments) * Math.PI * 2;
          ring.beginPath();
          ring.arc(0, 0, radius, start, start + ((Math.PI * 2) / segments) * (index % 2 ? 0.46 : 0.7));
          ring.strokePath();
        }
        ring.fillStyle(colors[index]!, 0.46);
        for (let rune = 0; rune < 7 + index * 3; rune += 1) {
          const angle = (rune / (7 + index * 3)) * Math.PI * 2;
          ring.fillCircle(Math.cos(angle) * radius, Math.sin(angle) * radius, Math.max(1.1, this.ringRadius * 0.011));
        }
      });
    }

    private drawRunes() {
      const g = this.runes.clear().setPosition(this.altarX, this.altarGroundY - this.altarVisibleH * 0.04);
      const radius = this.ringRadius * 1.02;
      g.lineStyle(1.2, this.tone.color, 0.5);
      g.strokeEllipse(0, radius * 0.3, radius * 2.1, radius * 0.72);
      const glyphs = 12;
      g.fillStyle(0xffe8b0, 0.5);
      for (let i = 0; i < glyphs; i += 1) {
        const a = (i / glyphs) * Math.PI * 2;
        g.fillRect(Math.cos(a) * radius * 1.02 - 1.4, Math.sin(a) * radius * 0.3 - 3, 2.8, 6);
      }
    }

    private updateEmitterZones() {
      const ellipse = () => new P.Geom.Ellipse(this.altarX, this.altarGroundY - this.ringRadius * 0.05, this.ringRadius * 2.1, this.ringRadius * 0.8);
      this.convergenceEmitter.clearEmitZones();
      this.convergenceEmitter.addEmitZone({ type: "edge", source: ellipse(), quantity: 112, seamless: true });
      const ringEllipse = new P.Geom.Ellipse(this.altarX, this.coreY, this.ringRadius * 1.9, this.ringRadius * 1.3);
      this.ringEmitter.clearEmitZones();
      this.ringEmitter.addEmitZone({ type: "edge", source: ringEllipse, quantity: 96, seamless: true });
    }

    private layoutFlames() {
      this.flameSprites.forEach((sprite, index) => {
        const angle = (index / this.flameSprites.length) * Math.PI * 2 - Math.PI * 0.5;
        sprite
          .setPosition(this.altarX + Math.cos(angle) * this.ringRadius * 0.9, this.coreY + Math.sin(angle) * this.ringRadius * 0.66)
          .setDisplaySize(this.ringRadius * 0.5, this.ringRadius * 0.5);
      });
    }

    private layoutMotes(width: number, height: number) {
      this.depthMotes.forEach((mote, index) => {
        const layer = index % 5;
        const spreadX = width * (0.34 + layer * 0.1);
        const spreadY = height * (0.2 + layer * 0.05);
        mote
          .setPosition(this.altarX + (index % 2 ? 1 : -1) * spreadX * (0.25 + (index % 4) * 0.14), this.coreY + (index % 3 - 1) * spreadY * 0.7)
          .setDisplaySize(this.ringRadius * (0.12 + layer * 0.06), this.ringRadius * (0.12 + layer * 0.06));
      });
    }

    // =====================================================================
    // GachaWorldController API
    // =====================================================================
    setPhase(next: GachaVfxPhase, rarityName: GachaVfxRarity = this.rarity) {
      if (!this.alive) return;
      this.vfxPhase = next;
      this.rarity = rarityName;
      this.phaseElapsed = 0;
      this.tone = RARITY_TONES[rarityName];
      const energy = phaseEnergy(next);
      this.targetIntensity = energy.intensity;
      this.targetAperture = energy.aperture;
      this.targetRingLayerAlpha = energy.ringAlpha;
      this.targetGlow = energy.glow;
      this.targetShaderRgb = [...this.tone.rgb];

      if (this.focused) this.cameraPhase = next;
      if (next !== "burst") this.burstKick = 0;

      this.ringEmitter.setParticleTint(this.tone.color);
      this.convergenceEmitter.setParticleTint(this.tone.color);
      this.burstEmitter.setParticleTint([0xffffff, this.tone.color, 0xffdf9d]);
      this.orbitStars.forEach((star) => star.setTint(this.tone.color));
      this.flameSprites.forEach((sprite) => sprite.setTint(this.tone.color));
      if (this.bloom) this.bloom.active = next === "omen" || next === "burst" || next === "reveal";

      if (next === "idle") {
        this.ringEmitter.setFrequency(reduceMotion ? 260 : 150);
        this.convergenceEmitter.stop();
      } else if (next === "charging") {
        this.ringEmitter.setFrequency(reduceMotion ? 120 : 54);
        this.convergenceEmitter.setFrequency(reduceMotion ? 95 : 38).start();
      } else if (next === "omen") {
        this.ringEmitter.setFrequency(reduceMotion ? 88 : 28);
        this.convergenceEmitter.setFrequency(reduceMotion ? 65 : 20).start();
      } else if (next === "burst") {
        this.convergenceEmitter.stop();
        this.triggerBurst();
      } else if (next === "reveal") {
        this.ringEmitter.setFrequency(reduceMotion ? 180 : 92);
        this.convergenceEmitter.stop();
      } else {
        this.ringEmitter.setFrequency(reduceMotion ? 240 : 150);
        this.convergenceEmitter.stop();
      }

      this.recomputeCameraTargets();
    }

    playOpenCamera(): Promise<void> {
      if (!this.alive) return Promise.resolve();
      this.cameraTransition += 1;
      if (!this.focused) {
        this.savedView = { cx: this.idleCenterX, cy: this.idleCenterY, zoom: this.idleZoom };
        this.focused = true;
        this.cameraPhase = nextCameraPhase("idle", "open");
        this.recomputeCameraTargets();
      }
      return this.wait(reduceMotion ? 0 : 850);
    }

    playCloseCamera(): Promise<void> {
      if (!this.alive) return Promise.resolve();
      const transition = ++this.cameraTransition;
      this.focused = false;
      this.cameraPhase = nextCameraPhase(this.cameraPhase === "idle" ? "result" : this.cameraPhase, "close");
      this.recomputeCameraTargets();
      return this.wait(reduceMotion ? 0 : 780).then(() => {
        if (
          this.alive &&
          transition === this.cameraTransition &&
          !this.focused
        )
          this.resetToIdle();
      });
    }

    setResultItem(assetKey: string | null, tier: number) {
      if (!this.alive) return;
      this.rarity = rarityForTier(tier);
      this.tone = RARITY_TONES[this.rarity];
      const src = assetKey || assets.fallbackItem;
      const key = `world-item:${src}`;
      if (this.textures.exists(key)) {
        this.revealResultItem(key);
        return;
      }
      const onError = (file: { key?: string }) => {
        if (file?.key !== key) return;
        cleanup();
        this.revealResultItem("world-core");
      };
      const completeEvent = `filecomplete-image-${key}`;
      const onComplete = () => {
        cleanup();
        this.revealResultItem(key);
      };
      const cleanup = () => {
        this.load.off(completeEvent, onComplete);
        this.load.off(P.Loader.Events.FILE_LOAD_ERROR, onError);
        this.pendingLoaderCleanups.delete(cleanup);
      };
      this.pendingLoaderCleanups.add(cleanup);
      this.load.once(completeEvent, onComplete);
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, onError);
      this.load.image(key, src);
      this.load.start();
    }

    resetToIdle() {
      if (!this.alive) return;
      this.cameraTransition += 1;
      this.focused = false;
      this.savedView = null;
      this.cameraPhase = "idle";
      this.hideResultItem();
      this.setPhase("idle", this.rarity);
      this.recomputeCameraTargets();
    }

    // =====================================================================
    // Camera helpers
    // =====================================================================
    private recomputeCameraTargets() {
      if (this.focused) {
        this.targetCenterX = this.focusCenterX;
        this.targetCenterY = this.focusCenterY;
        this.targetZoom = cameraZoomFor(this.vfxPhase, true);
      } else {
        const view = this.savedView;
        this.targetCenterX = view ? view.cx : this.idleCenterX;
        this.targetCenterY = view ? view.cy : this.idleCenterY;
        this.targetZoom = view ? view.zoom : this.idleZoom;
      }
    }

    private wait(duration: number): Promise<void> {
      return new Promise((resolve) => {
        if (duration <= 0) {
          resolve();
          return;
        }
        const settle = () => {
          this.pendingTimers.delete(id);
          resolve();
        };
        const id = window.setTimeout(settle, duration);
        this.pendingTimers.set(id, settle);
      });
    }

    // =====================================================================
    // Result item rise
    // =====================================================================
    private revealResultItem(key: string) {
      if (!this.textures.exists(key)) key = "world-core";
      this.resultItemActive = true;
      const size = this.ringRadius * 1.02;
      this.tweens.killTweensOf(this.resultItem);
      this.resultItem
        .setTexture(key)
        .setPosition(this.altarX, this.coreY)
        .setDisplaySize(size, size)
        .setAlpha(0)
        .setScale(this.resultItem.scaleX * 0.5)
        .setVisible(true);
      const targetScale = this.resultItem.scaleX * 2;
      this.tweens.add({
        targets: this.resultItem,
        y: this.coreY - this.ringRadius * 1.35,
        alpha: 1,
        scaleX: targetScale,
        scaleY: targetScale,
        duration: reduceMotion ? 220 : 620,
        ease: "Back.easeOut",
      });
    }

    private hideResultItem() {
      if (!this.resultItemActive) return;
      this.resultItemActive = false;
      this.tweens.killTweensOf(this.resultItem);
      this.tweens.add({
        targets: this.resultItem,
        alpha: 0,
        y: this.coreY,
        duration: reduceMotion ? 120 : 320,
        ease: "Cubic.easeIn",
      });
    }

    // =====================================================================
    // Burst
    // =====================================================================
    private triggerBurst() {
      this.burstEmitter.explode(reduceMotion ? 56 : 188, this.altarX, this.coreY);
      this.time.delayedCall(92, () => this.burstEmitter.explode(reduceMotion ? 18 : 58, this.altarX, this.coreY));

      if (this.impactSprite) {
        this.impactElapsed = 0;
        this.impactFrame = 0;
        this.impactSprite.setTexture(this.impactFrameKeys[0] ?? "world-impact").setVisible(true).setTint(this.tone.color).setAlpha(0.94);
      }

      if (!reduceMotion) {
        this.cameras.main.shake(150, 0.006, true);
        this.flashBurst();
        this.burstKick = 0.05;
      }

      [0, 78, 156].forEach((delay, index) => {
        const wave = this.world(
          this.add
            .ellipse(this.altarX, this.coreY, this.ringRadius * 0.72, this.ringRadius * 0.46)
            .setStrokeStyle(2.8 - index * 0.52, index === 1 ? 0xffffff : this.tone.color, 0.94)
            .setBlendMode(P.BlendModes.ADD)
            .setScrollFactor(1)
            .setScale(0.18)
            .setDepth(19),
        );
        this.tweens.add({
          targets: wave,
          alpha: { from: 0.96, to: 0 },
          scaleX: { from: 0.18, to: 3.5 + index * 0.46 },
          scaleY: { from: 0.18, to: 3.5 + index * 0.46 },
          duration: 640 + index * 110,
          delay,
          ease: "Cubic.easeOut",
          onComplete: () => wave.destroy(),
        });
      });
    }

    private flashBurst() {
      this.flashRect.setAlpha(0.5);
      this.tweens.add({ targets: this.flashRect, alpha: 0, duration: 240, ease: "Cubic.easeOut" });
    }

    // =====================================================================
    // Frame loop
    // =====================================================================
    update(time: number, delta: number) {
      if (!this.alive) return;
      this.phaseElapsed += delta;
      const dt = Math.min(delta, 40) / 1000;
      const smoothing = 1 - Math.exp(-(this.vfxPhase === "burst" ? 13 : 5.2) * dt);
      const colorSmoothing = 1 - Math.exp(-4.4 * dt);
      const cameraSmoothing = 1 - Math.exp(-5.2 * dt);

      this.intensity += (this.targetIntensity - this.intensity) * smoothing;
      this.aperture += (this.targetAperture - this.aperture) * smoothing;
      this.ringLayerAlpha += (this.targetRingLayerAlpha - this.ringLayerAlpha) * smoothing;
      this.glow += (this.targetGlow - this.glow) * smoothing;
      this.ringEmitter.setAlpha(this.ringLayerAlpha);
      this.shaderRgb = this.shaderRgb.map(
        (channel, index) => channel + (this.targetShaderRgb[index]! - channel) * colorSmoothing,
      ) as [number, number, number];

      // Camera easing (single continuous motion for buttery cinematic feel).
      this.burstKick *= Math.exp(-9 * dt);
      this.camZoom += (this.targetZoom + this.burstKick - this.camZoom) * cameraSmoothing;
      this.camCenterX += (this.targetCenterX - this.camCenterX) * cameraSmoothing;
      this.camCenterY += (this.targetCenterY - this.camCenterY) * cameraSmoothing;
      this.cameras.main.setZoom(this.camZoom).centerOn(this.camCenterX, this.camCenterY);

      const pulse = 0.5 + 0.5 * Math.sin(time * 0.0031);
      this.halo.setAlpha(0.32 + this.glow * 0.4 + pulse * 0.04).setRotation(time * 0.00006 + this.glow * 0.15);
      this.core.setAlpha(0.4 + this.glow * 0.55).setScale((this.ringRadius * 0.92) / this.core.width * (1 + pulse * 0.02 + this.intensity * 0.03));
      this.animateAltarModel(time, dt);
      this.altarShadow.setAlpha(0.42 + this.glow * 0.16);
      this.altarCast.setAlpha(0.34 + this.glow * 0.14);
      this.groundGlow.setAlpha(0.5 + this.glow * 0.5);
      this.perspective.setAlpha(0.4 + this.intensity * 0.4);

      this.rings.forEach((ring, index) => {
        ring.rotation += (index % 2 === 0 ? 1 : -1) * dt * (0.035 + index * 0.03) * (1 + this.intensity * 4.2);
        ring.setAlpha((0.045 + this.intensity * 0.17 + pulse * 0.018) * (1 - index * 0.08));
      });
      this.runes.setAlpha(0.3 + this.glow * 0.5).setRotation(Math.sin(time * 0.0004) * 0.04);

      this.animateClouds(time);
      this.animateSpiritLayers(time);
      this.animateOrbit(time);
      this.animateFlames(time);
      this.animateImpact(delta);
      this.animateMotes(time);
    }

    // Brings the altar + core "alive" during a summon: rising, breathing,
    // shaking and punching so the models react instead of standing still.
    private animateAltarModel(time: number, dt: number) {
      const phase = this.vfxPhase;
      const elapsed = this.phaseElapsed;
      const vh = this.altarVisibleH;
      const vw = this.altarVisibleW;
      const idleBob = Math.sin(time * 0.0013) * vh * 0.006;
      let yOffset = idleBob;
      let scale = 1 + Math.sin(time * 0.0013) * 0.004;
      let rot = 0;
      let coreLift = 0;
      let coreSpin = 0.4;

      if (phase === "charging") {
        const t = Math.min(1, elapsed / 1100);
        const ease = t * t * (3 - 2 * t);
        yOffset = -vh * 0.05 * ease + idleBob;
        scale = 1 + 0.035 * ease;
        rot = Math.sin(time * 0.02) * 0.004 * ease;
        coreLift = -this.ringRadius * 0.18 * ease;
        coreSpin = 0.6 + 2.4 * ease;
      } else if (phase === "omen") {
        yOffset = -vh * 0.06 + Math.sin(time * 0.05) * vw * 0.005;
        scale = 1.05;
        rot = Math.sin(time * 0.045) * 0.008;
        coreLift = -this.ringRadius * 0.28 + Math.sin(time * 0.06) * this.ringRadius * 0.02;
        coreSpin = 4;
      } else if (phase === "burst") {
        const t = Math.min(1, elapsed / 450);
        const punch = Math.sin(t * Math.PI);
        yOffset = vh * 0.02 * punch + Math.sin(time * 0.12) * vw * 0.006 * (1 - t);
        scale = 1.06 + 0.08 * punch;
        rot = Math.sin(time * 0.1) * 0.012 * (1 - t);
        coreLift = -this.ringRadius * (0.28 + 0.55 * t);
        coreSpin = 7;
      } else if (phase === "reveal") {
        yOffset = -vh * 0.02 + idleBob;
        scale = 1.02;
        coreLift = -this.ringRadius * 0.1;
        coreSpin = 1.6;
      }

      this.coreAngle += coreSpin * dt;
      this.altar
        .setPosition(this.altarX, this.altarSpriteBaseY + yOffset)
        .setDisplaySize(this.altarDisplayW * scale, this.altarDisplayH * scale)
        .setRotation(rot);
      this.core.setPosition(this.altarX, this.coreY + coreLift).setRotation(this.coreAngle);
    }

    private animateClouds(time: number) {
      const span = this.viewW * 1.5;
      this.cloudsBack.forEach((cloud, index) => {
        const speed = 0.004 + index * 0.0022;
        const x = (((time * speed) % span) + span) % span - span * 0.5;
        cloud.setPosition(this.altarX + x + (index - 1) * this.viewW * 0.18, this.horizonY - this.viewH * (0.02 + index * 0.05));
      });
      this.cloudsFore.forEach((cloud, index) => {
        const speed = 0.01 + index * 0.006;
        const dir = index % 2 ? -1 : 1;
        const x = (((time * speed * dir) % span) + span) % span - span * 0.5;
        cloud.setPosition(this.altarX + x, this.viewH * (1.04 - index * 0.02) + Math.sin(time * 0.0006 + index) * this.viewH * 0.006);
      });
    }

    private animateSpiritLayers(time: number) {
      const phase = this.vfxPhase;
      const isCharge = phase === "charging";
      const isOmen = phase === "omen";
      const isBurst = phase === "burst";
      const isReveal = phase === "reveal";
      const chargeProgress = isCharge ? Math.min(1, this.phaseElapsed / 1100) : 0;
      const burstProgress = isBurst ? Math.min(1, this.phaseElapsed / 450) : 0;
      const dragonAlpha = isCharge ? chargeProgress * 0.34 : isOmen ? 0.52 : isBurst ? (1 - burstProgress) * 0.38 : isReveal ? 0.14 : 0;
      const vortexAlpha = isCharge ? 0.04 + chargeProgress * 0.24 : isOmen ? 0.42 : isBurst ? (1 - burstProgress) * 0.34 : isReveal ? 0.12 : phase === "idle" ? 0.03 : 0;
      const spiritScale = isBurst ? 0.2 + burstProgress * 1.86 : isCharge ? 1.13 - chargeProgress * 0.13 : 1;
      const dragonBase = (this.ringRadius * 2.82) / this.spiritDragon.width;
      const vortexBase = (this.ringRadius * 2.72) / this.vortexBack.width;
      // Reduce the hard transparent-art contour while preserving the VFX glow.
      this.spiritDragon.setAlpha(dragonAlpha * 0.72).setScale(spiritScale * dragonBase).setRotation(time * -0.00007);
      this.vortexBack.setAlpha(vortexAlpha * 0.55).setScale(spiritScale * 1.16 * vortexBase).setRotation(time * 0.00008);
      this.vortexFront.setAlpha(vortexAlpha).setScale(spiritScale * vortexBase).setRotation(time * -0.00015);
      this.portalShader?.setVisible(true);
    }

    private animateOrbit(time: number) {
      this.orbitStars.forEach((star, index) => {
        const p = time * (0.00018 + index * 0.000025) * (index % 2 ? -1 : 1) + index * 0.73;
        const orbitX = this.ringRadius * (1.12 + (index % 4) * 0.17);
        const orbitY = orbitX * (0.42 + (index % 3) * 0.06);
        const twinkle = 0.55 + Math.sin(time * 0.004 + index * 1.7) * 0.35;
        const boost = this.vfxPhase === "burst" ? 2.2 : this.vfxPhase === "omen" ? 1.4 : 1;
        star
          .setPosition(this.altarX + Math.cos(p) * orbitX, this.coreY + Math.sin(p) * orbitY)
          .setDisplaySize(this.ringRadius * 0.16 * boost, this.ringRadius * 0.16 * boost)
          .setAlpha((0.04 + this.intensity * 0.12) * twinkle * boost);
      });
    }

    private animateFlames(time: number) {
      this.flameSprites.forEach((sprite, index) => {
        const offset = index / Math.max(1, this.flameSprites.length);
        if (this.flameFrameKeys.length) {
          sprite.setTexture(this.flameFrameKeys[Math.floor(time / 50 + index * 2) % this.flameFrameKeys.length]!);
        }
        sprite.setAlpha((0.025 + this.intensity * 0.13) * (0.72 + Math.sin(time * 0.0027 + offset * Math.PI * 2) * 0.28));
        sprite.setRotation(Math.sin(time * 0.0009 + offset * 6.28) * 0.16);
      });
    }

    private animateImpact(delta: number) {
      if (!this.impactSprite || this.impactFrame < 0 || !this.impactFrameKeys.length) return;
      this.impactElapsed += delta;
      this.impactFrame = Math.floor(this.impactElapsed / (1000 / 24));
      if (this.impactFrame >= this.impactFrameKeys.length) {
        this.impactFrame = -1;
        this.impactSprite.setVisible(false);
      } else {
        this.impactSprite.setTexture(this.impactFrameKeys[this.impactFrame]!);
      }
    }

    private animateMotes(time: number) {
      this.depthMotes.forEach((mote, index) => {
        const layer = index % 5;
        const drift = time * (0.000012 + layer * 0.000006) * (index % 2 ? -1 : 1);
        const spreadX = this.viewW * (0.25 + layer * 0.08);
        const spreadY = this.viewH * (0.18 + layer * 0.035);
        const pulse = 0.62 + Math.sin(time * 0.0016 + index * 1.9) * 0.28;
        mote
          .setPosition(this.altarX + Math.sin(drift + index) * spreadX, this.coreY + Math.cos(drift * 1.3 + index * 0.8) * spreadY)
          .setAlpha((0.025 + this.intensity * 0.045) * pulse);
      });
    }

    // =====================================================================
    // Procedural textures + teardown
    // =====================================================================
    // Scans the alpha channel of a (downscaled) texture to find the visible
    // content's bounding box, so square art with transparent padding can be
    // grounded and sized by its real silhouette.
    private computeContentBounds(key: string) {
      const fallback = { top: 0, bottom: 1, left: 0, right: 1 };
      if (!this.textures.exists(key)) return fallback;
      const source = this.textures.get(key).getSourceImage() as HTMLImageElement;
      const w = source.naturalWidth || source.width;
      const h = source.naturalHeight || source.height;
      if (!w || !h) return fallback;
      const scale = Math.min(1, 220 / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return fallback;
      ctx.drawImage(source, 0, 0, sw, sh);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, sw, sh).data;
      } catch {
        return fallback;
      }
      let top = sh;
      let bottom = 0;
      let left = sw;
      let right = 0;
      const threshold = 18;
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          if (data[(y * sw + x) * 4 + 3]! > threshold) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      if (bottom < top || right < left) return fallback;
      return { top: top / sh, bottom: (bottom + 1) / sh, left: left / sw, right: (right + 1) / sw };
    }

    private makeProceduralTextures() {
      this.makeRadialTexture("world-soft", 96, [
        [0, "rgba(255,255,255,1)"],
        [0.14, "rgba(255,255,255,.95)"],
        [0.42, "rgba(255,255,255,.22)"],
        [1, "rgba(255,255,255,0)"],
      ]);
      // Vertical gradient (dark at top, transparent below) used to feather the
      // ground's top edge into the horizon and kill the mid-screen seam.
      const hgrad = this.textures.createCanvas("world-hgrad", 8, 128);
      if (hgrad) {
        const gradient = hgrad.context.createLinearGradient(0, 0, 0, 128);
        gradient.addColorStop(0, "rgba(5,15,21,0)");
        gradient.addColorStop(0.5, "rgba(5,15,21,.82)");
        gradient.addColorStop(1, "rgba(5,15,21,0)");
        hgrad.context.fillStyle = gradient;
        hgrad.context.fillRect(0, 0, 8, 128);
        hgrad.update();
      }
      const star = this.textures.createCanvas("world-star", 96, 96);
      if (star) {
        const gradient = star.context.createRadialGradient(48, 48, 0, 48, 48, 45);
        gradient.addColorStop(0, "rgba(255,255,255,1)");
        gradient.addColorStop(0.1, "rgba(255,255,255,.96)");
        gradient.addColorStop(0.42, "rgba(255,255,255,.12)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        star.context.fillStyle = gradient;
        star.context.fillRect(0, 0, 96, 96);
        star.context.fillStyle = "rgba(255,255,255,.82)";
        star.context.fillRect(47, 4, 2, 88);
        star.context.fillRect(4, 47, 88, 2);
        star.update();
      }
      // Soft wispy cloud puff built from a cluster of overlapping soft blobs.
      const cloud = this.textures.createCanvas("world-cloud", 320, 160);
      if (cloud) {
        const ctx = cloud.context;
        ctx.clearRect(0, 0, 320, 160);
        const blob = (cx: number, cy: number, r: number, a: number) => {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, `rgba(255,255,255,${a})`);
          g.addColorStop(0.55, `rgba(255,255,255,${a * 0.4})`);
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 320, 160);
        };
        blob(120, 92, 62, 0.5);
        blob(180, 80, 74, 0.55);
        blob(230, 96, 54, 0.42);
        blob(90, 100, 46, 0.36);
        blob(160, 104, 92, 0.32);
        cloud.update();
      }
      const streak = this.textures.createCanvas("world-streak", 180, 28);
      if (streak) {
        const horizontal = streak.context.createLinearGradient(0, 14, 180, 14);
        horizontal.addColorStop(0, "rgba(255,255,255,0)");
        horizontal.addColorStop(0.28, "rgba(255,255,255,.08)");
        horizontal.addColorStop(0.72, "rgba(255,255,255,.92)");
        horizontal.addColorStop(1, "rgba(255,255,255,0)");
        const vertical = streak.context.createLinearGradient(0, 0, 0, 28);
        vertical.addColorStop(0, "rgba(255,255,255,0)");
        vertical.addColorStop(0.28, "rgba(255,255,255,.18)");
        vertical.addColorStop(0.5, "rgba(255,255,255,1)");
        vertical.addColorStop(0.72, "rgba(255,255,255,.18)");
        vertical.addColorStop(1, "rgba(255,255,255,0)");
        streak.context.fillStyle = horizontal;
        streak.context.fillRect(0, 0, 180, 28);
        streak.context.globalCompositeOperation = "destination-in";
        streak.context.fillStyle = vertical;
        streak.context.fillRect(0, 0, 180, 28);
        streak.context.globalCompositeOperation = "source-over";
        streak.update();
      }
      // Soft horizon fog band.
      const fog = this.textures.createCanvas("world-fog", 256, 128);
      if (fog) {
        const gradient = fog.context.createLinearGradient(0, 0, 0, 128);
        gradient.addColorStop(0, "rgba(120,210,220,0)");
        gradient.addColorStop(0.5, "rgba(120,210,220,.5)");
        gradient.addColorStop(1, "rgba(120,210,220,0)");
        fog.context.fillStyle = gradient;
        fog.context.fillRect(0, 0, 256, 128);
        fog.update();
      }
      // Distant starfield.
      const stars = this.textures.createCanvas("world-stars", 512, 256);
      if (stars) {
        const ctx = stars.context;
        ctx.clearRect(0, 0, 512, 256);
        for (let i = 0; i < 220; i += 1) {
          const x = Math.random() * 512;
          const y = Math.random() * 256;
          const r = Math.random() * 1.3 + 0.2;
          ctx.globalAlpha = 0.3 + Math.random() * 0.6;
          ctx.fillStyle = i % 5 === 0 ? "#ffe6a6" : i % 3 === 0 ? "#a6e2ff" : "#ffffff";
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        stars.update();
      }
      // Screen-space vignette (transparent center, dark edges).
      const vignette = this.textures.createCanvas("world-vignette", 256, 256);
      if (vignette) {
        const gradient = vignette.context.createRadialGradient(128, 118, 40, 128, 128, 190);
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(0.62, "rgba(2,7,11,0)");
        gradient.addColorStop(1, "rgba(2,6,10,.72)");
        vignette.context.fillStyle = gradient;
        vignette.context.fillRect(0, 0, 256, 256);
        vignette.update();
      }
    }

    private makeRadialTexture(key: string, size: number, stops: Array<[number, string]>) {
      if (this.textures.exists(key)) return;
      const canvas = this.textures.createCanvas(key, size, size);
      if (!canvas) return;
      const gradient = canvas.context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const [offset, color] of stops) gradient.addColorStop(offset, color);
      canvas.context.fillStyle = gradient;
      canvas.context.fillRect(0, 0, size, size);
      canvas.update();
    }

    private makeSoftImageTexture(sourceKey: string, targetKey: string) {
      if (!this.textures.exists(sourceKey) || this.textures.exists(targetKey)) return;
      const source = this.textures.get(sourceKey).getSourceImage() as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth || source.width;
      canvas.height = source.naturalHeight || source.height;
      const context = canvas.getContext("2d");
      if (!context) return;
context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const red = pixels.data[index]!;
        const green = pixels.data[index + 1]!;
        const blue = pixels.data[index + 2]!;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        if (luminance < 18) pixels.data[index + 3] = 0;
        else if (luminance < 72) pixels.data[index + 3] = Math.round(pixels.data[index + 3]! * (luminance - 18) / 54);
      }
      context.putImageData(pixels, 0, 0);
      context.globalCompositeOperation = "destination-in";
      const horizontal = context.createLinearGradient(0, 0, canvas.width, 0);
      horizontal.addColorStop(0, "rgba(255,255,255,0)");
      horizontal.addColorStop(0.1, "rgba(255,255,255,.7)");
      horizontal.addColorStop(0.2, "rgba(255,255,255,1)");
      horizontal.addColorStop(0.8, "rgba(255,255,255,1)");
      horizontal.addColorStop(0.9, "rgba(255,255,255,.7)");
      horizontal.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = horizontal;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
      vertical.addColorStop(0, "rgba(255,255,255,0)");
      vertical.addColorStop(0.12, "rgba(255,255,255,.72)");
      vertical.addColorStop(0.24, "rgba(255,255,255,1)");
      vertical.addColorStop(0.78, "rgba(255,255,255,1)");
      vertical.addColorStop(0.9, "rgba(255,255,255,.72)");
      vertical.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = vertical;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";
      this.textures.addCanvas(targetKey, canvas);
    }
    private makeSoftFrameTextures(sourceKey: string, prefix: string): string[] {
      if (!this.textures.exists(sourceKey)) return [];
      const source = this.textures.get(sourceKey).getSourceImage() as HTMLImageElement;
      const frameSize = 256;
      const sourceWidth = source.naturalWidth || source.width;
      const sourceHeight = source.naturalHeight || source.height;
      const columns = Math.floor(sourceWidth / frameSize);
      const rows = Math.floor(sourceHeight / frameSize);
      if (!columns || !rows) return [];
      const keys: string[] = [];
      for (let frame = 0; frame < columns * rows; frame += 1) {
        const key = `${prefix}-${frame}`;
        if (this.textures.exists(key)) {
          keys.push(key);
          continue;
        }
        const canvas = document.createElement("canvas");
        canvas.width = frameSize;
        canvas.height = frameSize;
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.imageSmoothingEnabled = true;
        context.drawImage(source, (frame % columns) * frameSize, Math.floor(frame / columns) * frameSize, frameSize, frameSize, 0, 0, frameSize, frameSize);        const pixels = context.getImageData(0, 0, frameSize, frameSize);
        for (let index = 0; index < pixels.data.length; index += 4) {
          const red = pixels.data[index]!;
          const green = pixels.data[index + 1]!;
          const blue = pixels.data[index + 2]!;
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          if (luminance < 22) pixels.data[index + 3] = 0;
          else if (luminance < 78) pixels.data[index + 3] = Math.round(pixels.data[index + 3]! * (luminance - 22) / 56);
        }
        context.putImageData(pixels, 0, 0);
        const mask = context.createRadialGradient(128, 128, 80, 128, 128, 178);
        mask.addColorStop(0, "rgba(255,255,255,1)");
        mask.addColorStop(0.7, "rgba(255,255,255,.98)");
        mask.addColorStop(0.9, "rgba(255,255,255,.34)");
        mask.addColorStop(1, "rgba(255,255,255,0)");
        context.globalCompositeOperation = "destination-in";
        context.fillStyle = mask;
        context.fillRect(0, 0, frameSize, frameSize);
        context.globalCompositeOperation = "source-over";
        this.textures.addCanvas(key, canvas);
        keys.push(key);
      }
      return keys;
    }

    private teardown() {
      this.alive = false;
      this.cameraTransition += 1;
      this.pendingLoaderCleanups.forEach((cleanup) => cleanup());
      this.pendingLoaderCleanups.clear();
      this.pendingTimers.forEach((settle, id) => {
        window.clearTimeout(id);
        settle();
      });
      this.pendingTimers.clear();
    }
  }

  return GachaWorldScene as unknown as new () => Phaser.Scene;
}
