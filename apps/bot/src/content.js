import { createHash } from "node:crypto";

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/giu;
const MENTION_PATTERN = /<[@#][!&]?\d+>/gu;
const EMOJI_PATTERN = /<a?:[\w~]+:\d+>/gu;

export function normalizeMessageContent(content) {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(URL_PATTERN, " ")
    .replace(MENTION_PATTERN, " ")
    .replace(EMOJI_PATTERN, " ")
    .replace(/[^\p{L}\p{N}\s.!?]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function validateChatContent(content) {
  const trimmed = content.trim();
  if (!trimmed || /^[!/]/u.test(trimmed))
    return { eligible: false, reason: "command_or_empty" };

  const normalized = normalizeMessageContent(content);
  const meaningfulChars = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (meaningfulChars < 8) return { eligible: false, reason: "too_short" };

  const uniqueCharacters = new Set(normalized.match(/[\p{L}\p{N}]/gu) ?? [])
    .size;
  const sentenceCount = Math.max(
    1,
    normalized.split(/[.!?]+/u).filter(Boolean).length,
  );
  return {
    eligible: true,
    uniqueCharacters,
    sentenceCount,
    fingerprint: simhash(normalized),
  };
}

function simhash(content) {
  const compact = content.replace(/[.!?]/gu, "").replace(/\s+/gu, " ");
  const features =
    compact.length < 3
      ? [compact]
      : Array.from({ length: compact.length - 2 }, (_, i) =>
          compact.slice(i, i + 3),
        );
  const weights = new Int32Array(64);
  for (const feature of features) {
    const hash = createHash("sha256")
      .update(feature)
      .digest()
      .readBigUInt64BE();
    for (let bit = 0n; bit < 64n; bit += 1n)
      weights[Number(bit)] += (hash & (1n << bit)) === 0n ? -1 : 1;
  }
  let fp = 0n;
  for (let bit = 0n; bit < 64n; bit += 1n)
    if (weights[Number(bit)] >= 0) fp |= 1n << bit;
  return fp.toString(16).padStart(16, "0");
}
