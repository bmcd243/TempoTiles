import { IntervalBlock, IntervalStep } from "./types";

const UNIT_TO_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
  s: 1,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
};

const SEGMENT_SPLIT_REGEX =
  /\b(?:followed by|finishing with|then|after that|and then)\b|,/i;

function createIdGenerator() {
  let counter = 0;
  return () => `interval_${counter++}_${Date.now()}`;
}

function cleanText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function capitalize(word: string) {
  if (!word) return word;
  return word[0].toUpperCase() + word.slice(1);
}

function parseSingleSegment(segment: string) {
  const match = segment.match(
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min)\s+(.+)$/i
  );
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const label = capitalize(cleanText(match[3]));
  const seconds = value * (UNIT_TO_SECONDS[unit] ?? 1);
  return { label, durationSec: Math.round(seconds) };
}

function buildSetLabel(items: IntervalStep[]) {
  if (!items.length) return "Set";
  if (items.length === 1) return `Set: ${items[0].label}`;
  const preview = items.slice(0, 2).map((item) => item.label).join(" + ");
  return `Set: ${preview}${items.length > 2 ? " + ..." : ""}`;
}

function parseSetSegment(
  segment: string,
  nextId: () => string
): IntervalBlock | null {
  const setMatch = segment.match(/(\d+)\s*(?:sets?|x)\s+of\s+(.+)$/i);
  if (!setMatch) return null;
  const repeat = Math.max(1, Number(setMatch[1]));
  const rest = cleanText(setMatch[2]);
  const parts = rest
    .split(/\b(?:followed by|then|and then|after that)\b|,/i)
    .map((part) => cleanText(part))
    .filter(Boolean);
  const items = parts
    .map((part) => parseSingleSegment(part))
    .filter(Boolean)
    .map((parsed) => ({
      id: nextId(),
      label: parsed!.label,
      durationSec: parsed!.durationSec,
    }));
  if (!items.length) return null;
  return {
    type: "set",
    id: nextId(),
    label: buildSetLabel(items),
    repeat,
    items,
  };
}

function extractSetClauses(input: string) {
  const sets: Array<{ token: string; segment: string }> = [];
  let index = 0;
  let remaining = input;
  const pattern =
    /(\d+)\s*(?:sets?|x)\s+of\s+(.+?)(?=\b(?:finishing with|then|after that|and then)\b|,|$)/i;
  while (true) {
    const match = remaining.match(pattern);
    if (!match || match.index == null) break;
    const full = match[0];
    const prefix = remaining.slice(0, match.index);
    const suffix = remaining.slice(match.index + full.length);
    const token = `__SET__${index}__`;
    sets.push({ token, segment: full });
    remaining = `${prefix}${token}${suffix}`;
    index += 1;
  }
  return { text: remaining, sets };
}

export function parseIntervals(input: string): IntervalBlock[] {
  if (!input.trim()) return [];
  const nextId = createIdGenerator();
  const normalized = input
    .replace(/[\.\!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const { text, sets } = extractSetClauses(normalized);
  const segments = text
    .split(SEGMENT_SPLIT_REGEX)
    .map((segment) => cleanText(segment.replace(/^(a|an)\s+/i, "")))
    .filter(Boolean);

  const result: IntervalBlock[] = [];
  for (const segment of segments) {
    const setToken = sets.find((entry) => entry.token === segment);
    if (setToken) {
      const setBlock = parseSetSegment(setToken.segment, nextId);
      if (setBlock) {
        result.push(setBlock);
      }
      continue;
    }
    const parsed = parseSingleSegment(segment);
    if (!parsed) continue;
    result.push({
      type: "interval",
      id: nextId(),
      ...parsed,
    });
  }
  return result;
}
