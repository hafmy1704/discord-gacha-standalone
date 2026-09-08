import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { GachaVfx } from "./GachaVfx";
import { rarityForTier, type GachaWorldController } from "./gachaWorldTypes";
import { GACHA_WORLD_ASSETS } from "./gachaWorldAssets";
import {
  GACHA_ANIMATION_MS,
  gachaCycleDeadline,
} from "./gachaTiming.mjs";

type Stats = Record<string, number>;
type Phase = "idle" | "charging" | "omen" | "burst" | "reveal" | "result";
type View = "summon" | "equipment" | "catalog";

type CatalogItem = {
  itemCode: string;
  tier: number;
  tierLabel: string;
  slot: string;
  slotLabel: string;
  name: string;
  slotBudget: number;
  assetKey: string | null;
};

type Equipment = {
  itemCode: string;
  name: string;
  slot: string;
  slotLabel: string;
  tier: number;
  ageYears: number;
  stats: Stats;
  power: number;
  assetKey: string | null;
  acquiredAt?: string;
};

type Disposition = "equipped" | "replaced" | "salvaged";

type Session = {
  soulOrders: number;
  vaultXp: number;
  vaultLevel: number;
  upgradeCost: number;
  vaultProgressXp: number;
  vaultProgress: number;
  canDraw: boolean;
  totalRolls: number;
  tierRates: Array<{ tier: number; rate: number }>;
  tierRatePreviews: Array<{ level: number; rates: Array<{ tier: number; rate: number }> }>;
  equipmentCount: number;
  equipmentPower: number;
  equipped: Equipment[];
  collection: Array<{ itemCode: string; tier: number; slot: string; rollCount: number }>;
  collectionSummary: {
    discoveredCount: number;
    totalCount: number;
    byTier: Array<{ tier: number; discoveredCount: number; totalCount: number }>;
  };
  history: RollResult[];
};

type RollResult = {
  requestId: string;
  itemCode: string;
  slot: string;
  tier: number;
  ageYears: number;
  stats: Stats;
  power: number;
  disposition: Disposition;
  replacedItemCode: string | null;
  salvageSteel: number;
  vaultXpAfter: number;
  session: Session;
};

type ApiError = Error & { code?: string };

type LeaderboardEntry = {
  rank: number;
  power: number;
  vaultLevel: number;
  cultivationLevel: number;
  highestTier: number;
  tag: string;
  isSelf: boolean;
};

type Leaderboard = {
  entries: LeaderboardEntry[];
  self: { rank: number; power: number; vaultLevel: number; highestTier: number; tag: string } | null;
  totalPlayers: number;
};

const initialToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
if (initialToken) history.replaceState(null, "", `${location.pathname}${location.search}`);
let token = initialToken;
let tokenPromise: Promise<string> | null = null;
const clientId = import.meta.env.VITE_DISCORD_APPLICATION_ID;
const apiPrefix = "";
const activityTokenPath = "/api/activity/token";
const API_TIMEOUT_MS = 10_000;
const PENDING_DRAW_REQUEST_KEY = "discord-gacha:pending-draw-request";
const SESSION_POLL_MS = 7000;
const LEADERBOARD_POLL_MS = 9000;
const statLabels: Record<string, string> = {
  attack: "Công", hp: "HP", accuracy: "Chuẩn",
  basicPower: "Kỹ năng thường", skillPower: "Kỹ năng", ultimatePower: "Tuyệt kỹ",
  speed: "Tốc", critRate: "Bạo kích", critDamage: "Bạo thương",
  skillHaste: "Giảm hồi", evasion: "Né tránh",
};
const numberFormat = new Intl.NumberFormat("vi-VN");

async function readJsonResponse(response: Response, endpoint = "api"): Promise<any> {
  const body = await response.text();
  if (!body.trim()) throw new Error(`empty_response_${response.status}_${endpoint}`);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid_json_response_${response.status}_${endpoint}`);
  }
}
async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  endpoint: string,
  shouldRetry: (response: Response | null, value: unknown) => boolean,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const value = await readJsonResponse(response, endpoint);
      if (!shouldRetry(response, value) || attempt === 2) return { response, value };
    } catch (reason) {
      lastError = reason;
      if (attempt === 2 || !shouldRetry(null, reason)) throw reason;
      await sleep(250 * (attempt + 1));
      continue;
    }
    await sleep(250 * (attempt + 1));
  }
  throw lastError;
}

function isTransientActivityTokenError(code: string) {
  return code.startsWith("empty_response_")
    || code.startsWith("invalid_json_response_")
    || code.startsWith("http_5")
    || code === "activity_auth_unavailable";
}

async function exchangeActivityCodeForLaunchToken(code: string): Promise<void> {
  let lastError: unknown;
  try {
      const { response, value } = await fetchJsonWithRetry(
        activityTokenPath,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        },
        activityTokenPath,
        (response, value) => {
          if (!response) return value instanceof Error && value.message !== "activity_token_invalid_payload";
          if (response.ok) return false;
          const code = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
            ? value.error
            : `http_${response.status}_${activityTokenPath}`;
          return response.status >= 500 || isTransientActivityTokenError(code);
        },
      );
      if (!response.ok) throw new Error(value.error || `http_${response.status}_/api/activity/token`);
      if (value.ok !== true) throw new Error("activity_token_invalid_payload");
      return;
    } catch (reason) {
      lastError = reason;
  }
  throw lastError;
}
async function ensureToken() {
  if (token) return token;
  if (!tokenPromise) {
    tokenPromise = (async () => {
      if (!clientId) throw new Error("activity_auth_unavailable");
      if (!new URLSearchParams(location.search).has("frame_id"))
        throw new Error("activity_open_in_discord");
      const discordSdk = new DiscordSDK(clientId);
      await discordSdk.ready();
      let lastError: unknown;
      for (let authAttempt = 0; authAttempt < 3; authAttempt += 1) {
        try {
          const { code } = await discordSdk.commands.authorize({
            client_id: clientId,
            response_type: "code",
            state: crypto.randomUUID(),
            prompt: "none",
            scope: ["identify"],
          });
          await exchangeActivityCodeForLaunchToken(code);
          return token;
        } catch (reason) {
          lastError = reason;
          const failure = errorCode(reason);
          if (!isTransientActivityTokenError(failure) || authAttempt === 2) throw reason;
          await sleep(400 * (authAttempt + 1));
        }
      }
      if (!lastError) throw new Error("activity_auth_failed");
      throw lastError;
    })().catch((reason) => {
      tokenPromise = null;
      throw reason;
    });
  }
  return tokenPromise;
}

function isLaunchTokenExpired(code: string) {
  return code === "invalid launch token" || code === "expired launch token";
}

async function api<T>(path: string, init?: RequestInit) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const launchToken = await ensureToken();
    const response = await fetch(`${apiPrefix}${path}`, {
      ...init,
      credentials: "same-origin",
      signal: init?.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
        ...(launchToken ? { authorization: `Bearer ${launchToken}` } : {}),
      },
    });
    const value = await readJsonResponse(response, path);
    if (response.ok) return value as T;
    const code = typeof value.error === "string" ? value.error : "backend_error";
    if (attempt === 0 && isLaunchTokenExpired(code)) {
      token = "";
      tokenPromise = null;
      continue;
    }
    const error = new Error(code) as ApiError;
    error.code = code;
    throw error;
  }
  throw new Error("backend_error");
}

function isRetryableDrawError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "";
  return reason instanceof TypeError
    || (reason instanceof DOMException && ["AbortError", "TimeoutError"].includes(reason.name))
    || message === "backend_error"
    || message === "request_failed"
    || message === "response_serialization_failed"
    || message.startsWith("empty_response_")
    || message.startsWith("invalid_json_response_");
}

async function drawWithRetry(requestId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await api<RollResult>("/api/gacha/draw", {
        method: "POST",
        body: JSON.stringify({ requestId }),
      });
    } catch (reason) {
      lastError = reason;
      if (attempt === 1 || !isRetryableDrawError(reason)) throw reason;
      await sleep(350);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("backend_error");
}

function formatNumber(value: number) {
  return numberFormat.format(Math.round(value));
}

function formatRate(rate: number) {
  return `${(rate * 100).toFixed(2)}%`;
}

function formatAge(age: number) {
  return `${formatNumber(age)} năm`;
}

function getAsset(item: { assetKey: string | null }) {
  return item.assetKey || "/ui/generated/soul-prism.webp";
}

function statEntries(stats: Stats) {
  return Object.entries(stats ?? {}).map(([key, value]) => [statLabels[key] ?? key, Number(value)] as const);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function loadPendingDrawRequestId() {
  try {
    const value = window.sessionStorage.getItem(PENDING_DRAW_REQUEST_KEY);
    if (value && /^[A-Za-z0-9_-]{8,128}$/u.test(value)) return value;
    window.sessionStorage.removeItem(PENDING_DRAW_REQUEST_KEY);
  } catch {}
  return null;
}

function storePendingDrawRequestId(value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(PENDING_DRAW_REQUEST_KEY, value);
    else window.sessionStorage.removeItem(PENDING_DRAW_REQUEST_KEY);
  } catch {}
}

const Icon = ({ name }: { name: "spark" | "bag" | "book" | "ticket" | "gem" }) => {
  const paths = {
    spark: <path d="m12 2 1.7 5.1L19 9l-5.3 1.9L12 16l-1.7-5.1L5 9l5.3-1.9L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />,
    bag: <path d="M7.5 8V6.5a4.5 4.5 0 0 1 9 0V8M5 8h14l1 13H4L5 8Z" />,
    book: <path d="M4 4.5C7.6 3.6 10.3 4.4 12 6v14c-1.7-1.6-4.4-2.4-8-1.5v-14Zm16 0c-3.6-.9-6.3-.1-8 1.5v14c1.7-1.6 4.4-2.4 8-1.5v-14Z" />,
    ticket: <path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Zm8 2v2m0 2v2m0 2v2" />,
    gem: <path d="m7 4-4 6 9 11 9-11-4-6H7Zm-4 6h18M7 4l5 6 5-6m-5 6v11" />,
  } as const;
  return <svg className="hk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const ItemArt = ({ item }: { item: { assetKey: string | null; name: string } }) => (
  <img className="hk-item-art" src={getAsset(item)} alt={item.name} onError={(event) => { event.currentTarget.src = "/ui/generated/soul-prism.webp"; }} />
);

const StatList = ({ stats }: { stats: Stats }) => (
  <div className="hk-stat-list">
    {statEntries(stats).map(([label, value]) => <span key={label}>{label} <b>{formatNumber(value)}</b></span>)}
  </div>
);

const NavButton = ({ view, current, label, icon, onClick }: { view: View; current: View; label: string; icon: "spark" | "bag" | "book"; onClick: (view: View) => void }) => (
  <button className={`hk-nav ${current === view ? "is-active" : ""}`} type="button" onClick={() => onClick(view)}>
    <Icon name={icon} /><span>{label}</span>
  </button>
);

const VaultRatePanel = ({ session, catalog }: { session: Session; catalog: CatalogItem[] }) => {
  const currentPreviewIndex = session.tierRatePreviews.findIndex((entry) => entry.level === session.vaultLevel);
  const [previewIndex, setPreviewIndex] = useState(Math.max(0, currentPreviewIndex));
  useEffect(() => { setPreviewIndex(Math.max(0, session.tierRatePreviews.findIndex((entry) => entry.level === session.vaultLevel))); }, [session.vaultLevel, session.tierRatePreviews]);
  const preview = session.tierRatePreviews[previewIndex];
  const previewLevel = preview?.level ?? session.vaultLevel;
  const isCurrent = previewLevel === session.vaultLevel;
  const rates = preview?.rates ?? session.tierRates;
  const shown = rates.filter((entry) => entry.rate > 0);
  return (
    <section className="hk-panel hk-info-card">
      <div className="hk-info-vault">
        <div className="hk-panel-heading"><span className="hk-kicker">TÀNG BẢO CÁC</span><div className="hk-rate-level">
          <button type="button" className="hk-rate-step" aria-label="Xem cấp thấp hơn" disabled={previewIndex <= 0} onClick={() => setPreviewIndex((value) => value - 1)}>‹</button>
          <strong>Cấp {previewLevel}</strong>
          <button type="button" className="hk-rate-step" aria-label="Xem cấp cao hơn" disabled={previewIndex >= session.tierRatePreviews.length - 1} onClick={() => setPreviewIndex((value) => value + 1)}>›</button>
        </div></div>
        <div className="hk-vault-title"><span>Hồn Thiết</span><b>{formatNumber(session.vaultProgressXp)} <small>/ {formatNumber(session.upgradeCost)}</small></b></div>
        <div className="hk-progress"><i style={{ width: `${session.vaultProgress}%` }} /></div>
      </div>
      <div className="hk-info-divider" aria-hidden="true" />
      <div className="hk-info-rate">
        <div className="hk-rate-headline"><span className="hk-kicker">TỶ LỆ PHẨM CẤP</span></div>
        <div className="hk-rate-list">
          {shown.map((entry) => (
            <div key={entry.tier} className={`hk-rate-row tier-${entry.tier}`}>
              <span className="hk-rate-tier">T{entry.tier}</span>
              <div className="hk-rate-body"><em>{catalog.find((item) => item.tier === entry.tier)?.tierLabel ?? `Tier ${entry.tier}`}</em><i><b style={{ width: `${Math.max(3, entry.rate * 100)}%` }} /></i></div>
              <strong>{formatRate(entry.rate)}</strong>
            </div>
          ))}
        </div>
        {!isCurrent && <button type="button" className="hk-rate-reset" onClick={() => setPreviewIndex(Math.max(0, currentPreviewIndex))}>Về cấp hiện tại</button>}
      </div>
    </section>
  );
};

const LeaderboardPanel = ({ leaderboard, failed }: { leaderboard: Leaderboard | null; failed: boolean }) => (
  <section className="hk-panel hk-rank-card">
    <div className="hk-panel-heading"><div><span className="hk-kicker">THIÊN CƠ BẢNG</span><h2>Top 20</h2></div><small>{leaderboard ? `${formatNumber(leaderboard.totalPlayers)} đạo hữu` : "…"}</small></div>
    {!leaderboard ? (
      <p className="hk-rank-empty">{failed ? "Không tải được bảng xếp hạng · đang thử lại…" : "Đang tải bảng xếp hạng…"}</p>
    ) : leaderboard.entries.length === 0 ? (
      <p className="hk-rank-empty">Chưa có đạo hữu nào tranh phong.</p>
    ) : (
      <ol className="hk-rank-list">
        {leaderboard.entries.map((entry) => (
          <li key={entry.rank} className={`hk-rank-row ${entry.isSelf ? "is-self" : ""} ${entry.rank <= 3 ? `is-top rank-${entry.rank}` : ""}`}>
            <span className="hk-rank-num">{entry.rank}</span>
            <div className="hk-rank-id"><strong>{entry.isSelf ? "Bạn" : `Đạo Hữu #${entry.tag}`}</strong><small>Bảo Khố {entry.vaultLevel} · T{entry.highestTier}</small></div>
            <b className="hk-rank-power">{formatNumber(entry.power)}</b>
          </li>
        ))}
      </ol>
    )}
    {leaderboard?.self && leaderboard.self.rank > leaderboard.entries.length && (
      <div className="hk-rank-self"><span className="hk-rank-num">{leaderboard.self.rank}</span><div className="hk-rank-id"><strong>Bạn</strong></div><b className="hk-rank-power">{formatNumber(leaderboard.self.power)}</b></div>
    )}
  </section>
);

const EquipmentCard = ({ item, tierLabel }: { item: Equipment; tierLabel: string }) => (
  <article className={`hk-equipment-card tier-${item.tier}`}>
    <div className="hk-equipment-ribbon"><span>{item.slotLabel ?? item.slot}</span><b>T{item.tier}</b></div>
    <div className="hk-equipment-art"><ItemArt item={item} /></div>
    <div className="hk-equipment-tier">{tierLabel}</div>
    <h3>{item.name}</h3>
    <div className="hk-equipment-power"><span>POWER</span><strong>{formatNumber(item.power)}</strong></div>
    <div className="hk-equipment-meta"><span>Niên Hạn {formatAge(item.ageYears)}</span></div>
    <StatList stats={item.stats} />
  </article>
);

const EmptySlotCard = ({ slot, slotLabel }: { slot: string; slotLabel: string }) => (
  <article className="hk-equipment-card is-empty">
    <div className="hk-equipment-ribbon"><span>{slotLabel}</span></div>
    <div className="hk-equipment-empty"><span>魂</span><small>Chưa có Hồn Khí</small></div>
  </article>
);

const EquipmentGrid = ({ equipped, catalog, count, power }: { equipped: Equipment[]; catalog: CatalogItem[]; count: number; power: number }) => {
  const bySlot = new Map(equipped.map((item) => [item.slot, item]));
  const slots = [...new Map(catalog.map((item) => [item.slot, item.slotLabel])).entries()];
  const tierLabels = new Map(catalog.map((item) => [item.tier, item.tierLabel]));
  return (
    <section className="hk-panel hk-equipment-panel">
      <div className="hk-panel-heading">
        <div><span className="hk-kicker">TRANG BỊ HIỆN TẠI</span><h2>Thập Nhị Hồn Vị</h2></div>
        <div className="hk-equipment-summary"><b>{count} / 12</b><span>Tổng Power {formatNumber(power)}</span></div>
      </div>
      <div className="hk-equipment-grid">{slots.map(([slot, slotLabel]) => { const item = bySlot.get(slot); return item ? <EquipmentCard key={slot} item={item} tierLabel={tierLabels.get(item.tier) ?? `Tier ${item.tier}`} /> : <EmptySlotCard key={slot} slot={slot} slotLabel={slotLabel} />; })}</div>
    </section>
  );
};

const LatestRoll = ({ result, catalog, onClose, closable }: { result: RollResult | null; catalog: CatalogItem[]; onClose: () => void; closable: boolean }) => {
  if (!result) return null;
  const item = catalog.find((entry) => entry.itemCode === result.itemCode);
  const display = item ?? { name: result.itemCode, slotLabel: result.slot, assetKey: null };
  const dispositionLabel = result.disposition === "salvaged"
    ? `Đã phân giải · +${formatNumber(result.salvageSteel)} Hồn Thiết`
    : result.disposition === "replaced" ? "Đã thay thế món cũ" : "Đã tự trang bị";
  return (
    <div key={result.requestId} className={`hk-latest-roll tier-${result.tier}`}>
      <div className="hk-latest-card-glow" aria-hidden="true" />
      <div className="hk-latest-card-header"><span className="hk-kicker">HỒN KHÍ ĐÃ ỨNG HIỆN</span><b>{dispositionLabel}</b>{closable && <button className="hk-latest-close" type="button" aria-label="Đóng kết quả triệu dẫn" onClick={onClose}>×</button>}</div>
      <div className="hk-latest-art-wrap">
        <span className="hk-latest-art-orbit" aria-hidden="true" />
        <div className="hk-latest-art"><ItemArt item={display} /><span>T{result.tier}</span></div>
      </div>
      <div className="hk-latest-copy"><h2>{display.name}</h2><p>{display.slotLabel} · Niên Hạn <b>{formatAge(result.ageYears)}</b></p><StatList stats={result.stats} /></div>
      <div className="hk-latest-power"><span>POWER</span><strong>{formatNumber(result.power)}</strong></div>
    </div>
  );
};

const SummonView = ({ session, catalog, phase, latest, autoRunning, opening, onDraw, onAuto, onStop, onCloseLatest, busy, worldFailed, onWorldReady, onWorldError, onWorldProgress, leaderboard, leaderboardFailed, countdown }: {
  session: Session;
  catalog: CatalogItem[];
  phase: Phase;
  latest: RollResult | null;
  autoRunning: boolean;
  opening: boolean;
  onDraw: () => void;
  onAuto: () => void;
  onStop: () => void;
  onCloseLatest: () => void;
  busy: boolean;
  worldFailed: boolean;
  onWorldReady: (controller: GachaWorldController) => void;
  onWorldError: (error: unknown) => void;
  onWorldProgress: (progress: number) => void;
  leaderboard: Leaderboard | null;
  leaderboardFailed: boolean;
  countdown: number;
}) => {
  const phaseLabel = countdown > 0 ? `HỒI PHỤC LINH LỰC · ${countdown}S` : phase === "idle" ? "SẴN SÀNG TRIỆU DẪN" : phase === "result" ? "LINH KHẾ ĐÃ THÀNH" : phase === "reveal" ? "LINH KHẾ ĐANG HIỆN" : "THIÊN MÔN ĐANG KHAI ẤN";
  const zoomed = phase !== "idle";
  return (
    <section className="hk-hub-page">
      <div className="hk-hub-grid">
        <div className="hk-hub-center">
          <div className={`hk-ritual hk-phase-${phase} tier-${latest?.tier ?? 1} ${autoRunning ? "is-auto" : ""} ${zoomed ? "is-zoomed" : ""} ${opening ? "is-opening" : ""}`}>
            <aside className="hk-ritual-overlay hk-info-float"><VaultRatePanel session={session} catalog={catalog} /></aside>
            <aside className="hk-ritual-overlay hk-rank-float"><LeaderboardPanel leaderboard={leaderboard} failed={leaderboardFailed} /></aside>
            <div className="hk-ritual-canvas">
              {worldFailed ? (
                <div className="hk-ritual-fallback" aria-hidden="true">
                  <div className="hk-ritual-fallback-sky" style={{ backgroundImage: "url('/ui/generated/gacha-sanctum-bg.webp')" }} />
                  <div className="hk-ritual-fallback-ground" style={{ backgroundImage: "url('/ui/generated/gacha-sanctum-ground.webp')" }} />
                  <img src="/ui/generated/summoning-altar.webp" alt="" className="hk-ritual-fallback-altar" />
                </div>
              ) : (
                <GachaVfx phase={phase} rarity={latest ? rarityForTier(latest.tier) : undefined} onReady={onWorldReady} onError={onWorldError} onProgress={onWorldProgress} />
              )}
            </div>
            <LatestRoll result={latest} catalog={catalog} onClose={onCloseLatest} closable={!autoRunning} />
            <div className="hk-ritual-status" aria-live="polite"><span>{phaseLabel}</span><small>{countdown > 0 ? "Lượt kế tiếp mở sau khi đủ 4 giây" : phase === "idle" ? "Chờ Hồn Lệnh khai môn" : "Linh lực đang hội tụ"}</small></div>
            <div className="hk-floating-actions">
              <div className="hk-floating-resource"><Icon name="ticket" /><strong>{formatNumber(session.soulOrders)}</strong><span>HỒN LỆNH</span></div>
              <button className="hk-float-button hk-float-single" type="button" aria-label="Triệu Dẫn x1" disabled={busy || autoRunning || !session.canDraw} onClick={onDraw}><span>X1</span></button>
              <button className={`hk-float-button hk-float-auto ${autoRunning ? "is-running" : ""}`} type="button" aria-label={autoRunning ? "Dừng triệu dẫn tự động" : "Triệu dẫn tự động"} disabled={!autoRunning && (busy || !session.canDraw)} onClick={autoRunning ? onStop : onAuto}><span>AUTO</span></button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const EquipmentView = ({ session, catalog }: { session: Session; catalog: CatalogItem[] }) => (
  <section className="hk-content-page"><div className="hk-page-heading"><span className="hk-kicker">BẢO KHỐ HIỆN HỮU</span><h1>Trang Bị Hồn Khí</h1><p>Không có inventory chờ thao tác. Mỗi slot chỉ giữ món có Power cao nhất.</p></div><EquipmentGrid equipped={session.equipped} catalog={catalog} count={session.equipmentCount} power={session.equipmentPower} /></section>
);

const CatalogView = ({ catalog, collection, collectionSummary, totalRolls }: { catalog: CatalogItem[]; collection: Session["collection"]; collectionSummary: Session["collectionSummary"]; totalRolls: number }) => {
  const rollCounts = new Map(collection.map((item) => [item.itemCode, item.rollCount]));
  const discovered = new Set(rollCounts.keys());
  return (
    <section className="hk-content-page">
      <div className="hk-page-heading"><span className="hk-kicker">ĐỒ GIÁM HỒN KHÍ</span><h1>Vạn Tượng Hồn Khí</h1><p>Đã khám phá {formatNumber(collectionSummary.discoveredCount)} / {formatNumber(collectionSummary.totalCount)} Hồn Khí · Tổng triệu dẫn {formatNumber(totalRolls)}</p></div>
      {collectionSummary.byTier.map((summary) => {
        const tier = summary.tier;
        const items = catalog.filter((item) => item.tier === tier);
        return (
          <section className={`hk-catalog-tier tier-${tier}`} key={tier}>
            <div className="hk-catalog-tier-head"><span className="hk-catalog-tier-badge">T{tier}</span><div><h2>{items[0]?.tierLabel ?? `Tier ${tier}`}</h2><span>{summary.discoveredCount} / {summary.totalCount} đã khám phá</span></div></div>
            <div className="hk-catalog-grid">{items.map((item) => discovered.has(item.itemCode) ? (
              <article className={`hk-catalog-card tier-${item.tier}`} key={item.itemCode}>
                <div className="hk-catalog-art"><ItemArt item={item} /><b>T{item.tier}</b></div>
                <div className="hk-catalog-info"><strong>{item.name}</strong><span>{item.slotLabel}</span><small>{formatNumber(rollCounts.get(item.itemCode) ?? 0)} lần triệu dẫn</small></div>
              </article>
            ) : (
              <article className={`hk-catalog-card is-locked tier-${item.tier}`} key={item.itemCode}>
                <div className="hk-catalog-art hk-catalog-locked" aria-hidden="true"><span>?</span></div>
                <div className="hk-catalog-info"><strong>Chưa khám phá</strong><span>{item.slotLabel}</span><small>Triệu dẫn để mở khoá</small></div>
              </article>
            ))}</div>
          </section>
        );
      })}
    </section>
  );
};

export const App = () => {
  const [view, setView] = useState<View>("summon");
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [latest, setLatest] = useState<RollResult | null>(null);
  const [error, setError] = useState("");
  const [autoRunning, setAutoRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [worldFailed, setWorldFailed] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [leaderboardFailed, setLeaderboardFailed] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [compact, setCompact] = useState(false);
  const [worldReady, setWorldReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(3);
  const sessionRef = useRef<Session | null>(null);
  const stopRequested = useRef(false);
  const ritualZoomedRef = useRef(false);
  const worldRef = useRef<GachaWorldController | null>(null);
  const catalogRef = useRef<CatalogItem[]>([]);
  const cooldownTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const autoRunningRef = useRef(false);
  const apiProgressRef = useRef(0);
  const imageLoadedRef = useRef(0);
  const imageTotalRef = useRef(0);
  const phaserProgressRef = useRef(0);
  const pendingDrawRequestIdRef = useRef<string | null>(
    loadPendingDrawRequestId(),
  );
  const sessionRequestVersionRef = useRef(0);
  const leaderboardRequestVersionRef = useRef(0);
  busyRef.current = busy;
  autoRunningRef.current = autoRunning;

  useEffect(() => {
    // Only collapse to the roll-only layout for a genuinely tiny PiP window —
    // both dimensions must be small so a normal (even short) desktop panel keeps its cards.
    const check = () => setCompact(window.innerWidth < 640 && window.innerHeight < 430);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Weighted progress: API 25% · images 55% · Phaser 20%
  const updateProgress = useCallback(() => {
    const api = apiProgressRef.current;
    const imgs = imageTotalRef.current > 0 ? imageLoadedRef.current / imageTotalRef.current : 0;
    const phaser = phaserProgressRef.current;
    setLoadProgress(Math.min(100, Math.round(api * 25 + imgs * 55 + phaser * 20)));
  }, []);

  // Kick off world-asset preloads in parallel with the API. Browser caches the
  // images so Phaser's own preload() hits memory and finishes near-instantly.
  useEffect(() => {
    const urls = [...new Set(Object.values(GACHA_WORLD_ASSETS))];
    imageTotalRef.current = urls.length;
    for (const url of urls) {
      const img = new window.Image();
      img.onload = img.onerror = () => {
        imageLoadedRef.current += 1;
        updateProgress();
      };
      img.src = url;
    }
  }, [updateProgress]);

  const refreshLeaderboard = () => {
    const requestVersion = ++leaderboardRequestVersionRef.current;
    api<Leaderboard>("/api/gacha/leaderboard")
      .then((next) => {
        if (requestVersion !== leaderboardRequestVersionRef.current) return;
        setLeaderboard(next);
        setLeaderboardFailed(false);
      })
      .catch(() => {
        if (requestVersion === leaderboardRequestVersionRef.current)
          setLeaderboardFailed(true);
      });
  };

  useEffect(() => {
    refreshLeaderboard();
    const timer = window.setInterval(refreshLeaderboard, LEADERBOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (cancelled || busyRef.current || autoRunningRef.current) return;
      const requestVersion = ++sessionRequestVersionRef.current;
      api<Session>("/api/gacha/session")
        .then((next) => {
          if (
            !cancelled &&
            requestVersion === sessionRequestVersionRef.current &&
            !busyRef.current &&
            !autoRunningRef.current
          )
            applySession(next);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(poll, SESSION_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestVersion = ++sessionRequestVersionRef.current;
    const sessionP = api<Session>("/api/gacha/session").then((s) => {
      if (!cancelled && requestVersion === sessionRequestVersionRef.current) {
        apiProgressRef.current = 0.5;
        updateProgress();
      }
      return s;
    });
    Promise.all([sessionP, api<CatalogItem[]>("/api/gacha/items")])
      .then(([nextSession, nextCatalog]) => {
        if (cancelled || requestVersion !== sessionRequestVersionRef.current) return;
        apiProgressRef.current = 1;
        sessionRef.current = nextSession;
        setSession(nextSession);
        catalogRef.current = nextCatalog;
        setCatalog(nextCatalog);
        updateProgress();
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
      stopRequested.current = true;
      sessionRequestVersionRef.current += 1;
      leaderboardRequestVersionRef.current += 1;
      if (cooldownTimerRef.current !== null)
        window.clearInterval(cooldownTimerRef.current);
    };
  }, [updateProgress]);

  const applySession = (nextSession: Session) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
  };

  const drawOne = async () => {
    sessionRequestVersionRef.current += 1;
    const needsZoom = !ritualZoomedRef.current;
    if (needsZoom) {
      ritualZoomedRef.current = true;
      setOpening(true);
      void worldRef.current?.playOpenCamera();
    }
    setLatest(null);
    setPhase("charging");
    const startedAt = performance.now();
    let cooldownEndsAt = gachaCycleDeadline(startedAt);
    let committed = false;
    if (cooldownTimerRef.current !== null) window.clearInterval(cooldownTimerRef.current);
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((cooldownEndsAt - performance.now()) / 1000));
      setCountdown(remaining);
      if (remaining === 0 && cooldownTimerRef.current !== null) {
        window.clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
    updateCountdown();
    cooldownTimerRef.current = window.setInterval(updateCountdown, 100);
    const requestId = pendingDrawRequestIdRef.current ?? crypto.randomUUID();
    pendingDrawRequestIdRef.current = requestId;
    storePendingDrawRequestId(requestId);
    const resultPromise = drawWithRetry(requestId);
    // Observe an early network failure while the reveal choreography continues;
    // the original promise is still awaited below and preserves the exception.
    void resultPromise.catch(() => {});
    try {
      await sleep(1100);
      setPhase("omen");
      await sleep(900);
      setPhase("burst");
      await sleep(450);
      setPhase("reveal");
      const result = await resultPromise;
      pendingDrawRequestIdRef.current = null;
      storePendingDrawRequestId(null);
      committed = true;
      applySession(result.session);
      const catalogItem = catalogRef.current.find((entry) => entry.itemCode === result.itemCode);
      worldRef.current?.setResultItem(catalogItem?.assetKey ?? null, result.tier);
      await sleep(Math.max(0, GACHA_ANIMATION_MS - (performance.now() - startedAt)));
      setLatest(result);
      setPhase("result");
      cooldownEndsAt = gachaCycleDeadline(startedAt, performance.now());
      updateCountdown();
      if (needsZoom) setOpening(false);
      return result;
    } catch (reason) {
      if (!isRetryableDrawError(reason)) {
        pendingDrawRequestIdRef.current = null;
        storePendingDrawRequestId(null);
      }
      throw reason;
    } finally {
      if (committed) await sleep(Math.max(0, cooldownEndsAt - performance.now()));
      if (cooldownTimerRef.current !== null) window.clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
      setCountdown(0);
    }
  };

  const draw = async () => {
    if (busyRef.current || autoRunningRef.current || !sessionRef.current) return;
    setError("");
    busyRef.current = true;
    setBusy(true);
    try { await drawOne(); }
    catch (reason) {
      ritualZoomedRef.current = false;
      setOpening(false);
      setPhase("idle");
      closeWorldCamera();
      setError(readableError(reason));
    }
    finally { busyRef.current = false; setBusy(false); refreshLeaderboard(); }
  };

  const autoDraw = async () => {
    if (busyRef.current || autoRunningRef.current || !sessionRef.current?.canDraw) return;
    setError("");
    stopRequested.current = false;
    autoRunningRef.current = true;
    setAutoRunning(true);
    try {
      while (!stopRequested.current && sessionRef.current?.canDraw) {
        await drawOne();
        if (!stopRequested.current && sessionRef.current?.canDraw) setLatest(null);
      }
    } catch (reason) {
      if (!stopRequested.current) setError(readableError(reason));
    } finally {
      autoRunningRef.current = false;
      setAutoRunning(false);
      setLatest(null);
      ritualZoomedRef.current = false;
      setOpening(false);
      setPhase("idle");
      closeWorldCamera();
      refreshLeaderboard();
    }
  };

  const closeWorldCamera = () => {
    const controller = worldRef.current;
    if (!controller) return;
    void controller.playCloseCamera();
  };

  const closeLatest = () => {
    if (busy || autoRunning) return;
    setLatest(null);
    ritualZoomedRef.current = false;
    setOpening(false);
    setPhase("idle");
    closeWorldCamera();
  };

  const stop = () => { stopRequested.current = true; };

  const handleWorldReady = (controller: GachaWorldController) => {
    worldRef.current = controller;
    setWorldFailed(false);
    phaserProgressRef.current = 1;
    setLoadProgress(100);
    setWorldReady(true);
  };

  const handleWorldError = (reason: unknown) => {
    worldRef.current = null;
    setWorldFailed(true);
    phaserProgressRef.current = 1;
    setLoadProgress(100);
    setWorldReady(true);
    if (import.meta.env.DEV) console.warn("Gacha world scene failed to start", reason);
  };

  const handleWorldProgress = useCallback((value: number) => {
    phaserProgressRef.current = value;
    updateProgress();
  }, [updateProgress]);

  const latestView = useMemo(() => latest, [latest]);
  const effectiveView: View = compact ? "summon" : view;
  const gachaActive = effectiveView === "summon" && phase !== "idle";
  const isLoading = !worldReady;
  const stageLabel = loadProgress < 30 ? "Kết nối Bảo Khố..."
    : loadProgress < 80 ? "Tải tài nguyên Thánh Địa..."
    : loadProgress < 100 ? "Khởi động Linh Trận..."
    : "Thánh Địa sẵn sàng!";

  return (
    <>
      {session && (
        <div
          className={`hk-app ${autoRunning ? "is-auto" : ""} ${compact ? "is-compact" : ""} ${gachaActive ? "is-gacha" : ""}`}
          aria-hidden={isLoading || undefined}
          style={isLoading ? { opacity: 0, pointerEvents: "none" } : undefined}
        >
          <nav className="hk-nav-dock" aria-label="Điều hướng Hồn Khí"><NavButton view="summon" current={effectiveView} label="Triệu Dẫn" icon="spark" onClick={setView} /><NavButton view="equipment" current={effectiveView} label="Trang Bị" icon="bag" onClick={setView} /><NavButton view="catalog" current={effectiveView} label="Đồ Giám" icon="book" onClick={setView} /></nav>
          {error && <p className="hk-error" role="alert">{error}</p>}
          <main className="hk-main">{effectiveView === "summon" && <SummonView session={session} catalog={catalog} phase={phase} latest={latestView} autoRunning={autoRunning} opening={opening} onDraw={draw} onAuto={autoDraw} onStop={stop} onCloseLatest={closeLatest} busy={busy} worldFailed={worldFailed} onWorldReady={handleWorldReady} onWorldError={handleWorldError} onWorldProgress={handleWorldProgress} leaderboard={leaderboard} leaderboardFailed={leaderboardFailed} countdown={countdown} />}{effectiveView === "equipment" && <EquipmentView session={session} catalog={catalog} />}{effectiveView === "catalog" && <CatalogView catalog={catalog} collection={session.collection} collectionSummary={session.collectionSummary} totalRolls={session.totalRolls} />}</main>
        </div>
      )}
      {isLoading && (
        <main className={`hk-loading ${error ? "has-error" : ""}`} aria-live="polite">
          <div className="hk-loading-stars" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <div className="hk-loading-seal" aria-hidden="true"><span className="hk-loading-orbit" /><span className="hk-loading-orbit hk-loading-orbit-two" /><span className="hk-loading-core">魂</span></div>
          <div className="hk-loading-copy">
            <span className="hk-loading-kicker">HỒN KHÍ · BẢO KHỐ</span>
            <strong>{error ? "Kết nối gián đoạn" : "Đang thức tỉnh"}</strong>
            <p>{error || stageLabel}</p>
            {!error && (
              <>
                <span className="hk-loading-progress"><i style={{ width: `${loadProgress}%` }} /></span>
                <span className="hk-loading-pct">{loadProgress}%</span>
              </>
            )}
          </div>
        </main>
      )}
    </>
  );
};

function readableError(reason: unknown) {
  const code = errorCode(reason);
  if (code.includes("/api/activity/token"))
    return "Kênh xác thực Discord đang gián đoạn, Activity sẽ tự xin lại phiên. Nếu lỗi kéo dài hãy mở lại Activity.";
  return {
    insufficient_soul_orders: "Không còn Hồn Lệnh.",
    gacha_cooldown: "Linh lực đang hồi phục. Chờ đủ 4 giây.",
    not_enrolled: "Hãy bấm Thức Tỉnh trong Discord trước.",
    gacha_empty: "Catalog Hồn Khí chưa sẵn sàng.",
    activity_auth_failed: "Discord chưa cấp được phiên Activity. Đóng rồi mở lại Activity.",
    activity_open_in_discord: "Hãy mở bằng lệnh /gacha trong Discord, không mở trực tiếp URL tunnel.",
    "expired launch token": "Phiên Activity đã hết hạn. Đóng rồi mở lại Activity.",
    "invalid launch token": "Phiên Activity không hợp lệ. Đóng rồi mở lại Activity.",
    csrf_rejected: "Phiên bảo mật không hợp lệ. Đóng rồi mở lại Activity.",
    rate_limited: "Thao tác quá nhanh. Chờ một chút rồi thử lại.",
    backend_unavailable: "Backend đang tạm thời không khả dụng. Thử lại sau.",
  }[code] ?? "Backend từ chối lượt thao tác. Thử lại sau.";
}

function errorCode(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "object" && reason !== null) {
    const value = reason as { code?: unknown; message?: unknown; error?: unknown };
    for (const candidate of [value.code, value.message, value.error])
      if (typeof candidate === "string" && candidate) return candidate;
  }
  return "backend_error";
}

function errorMessage(reason: unknown) {
  const code = errorCode(reason);
  if (code.includes("/api/activity/token"))
    return "Không thể tạo phiên Discord Activity tạm thời. Hệ thống đã retry tự động, hãy thử mở lại Activity nếu vẫn lỗi.";
  return code === "not_enrolled"
    ? "Hãy bấm Thức Tỉnh trong Discord trước."
    : `Không tải được Hồn Khí: ${code}`;
}



