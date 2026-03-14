import { IntervalBlock, IntervalStep } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

function getApiKey() {
  return process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
}

function getBaseUrl() {
  return process.env.EXPO_PUBLIC_OPENAI_BASE_URL || DEFAULT_BASE_URL;
}

function createIdGenerator() {
  let counter = 0;
  return () => `interval_${counter++}_${Date.now()}`;
}

function normalizeSteps(items: Array<{ label: string; durationSec: number }>) {
  const nextId = createIdGenerator();
  return items.map((item) => ({
    id: nextId(),
    label: item.label.trim(),
    durationSec: Math.max(1, Math.round(item.durationSec)),
  }));
}

function normalizeBlocks(blocks: Array<Record<string, unknown>>): IntervalBlock[] {
  const nextId = createIdGenerator();
  const result: IntervalBlock[] = [];
  for (const raw of blocks) {
    const type = raw.type;
    if (type === "set") {
      const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
      const items = normalizeSteps(
        itemsRaw.map((item) => ({
          label: String(item.label ?? ""),
          durationSec: Number(item.durationSec ?? 0),
        }))
      );
      if (!items.length) continue;
      result.push({
        type: "set",
        id: nextId(),
        label: String(raw.label ?? "Set"),
        repeat: Math.max(1, Number(raw.repeat ?? 1)),
        items,
      });
      continue;
    }
    if (type === "interval") {
      const label = String(raw.label ?? "");
      const durationSec = Math.max(1, Math.round(Number(raw.durationSec ?? 0)));
      if (!label || !durationSec) continue;
      result.push({
        type: "interval",
        id: nextId(),
        label,
        durationSec,
      });
    }
  }
  return result;
}

type ParseOptions = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export async function parseIntervalsAI(
  input: string,
  options?: ParseOptions
): Promise<IntervalBlock[]> {
  const baseUrl = options?.baseUrl || getBaseUrl();
  const apiKey = options?.apiKey ?? getApiKey();
  const url = `${baseUrl}/chat/completions`;
  const isDefaultApi = baseUrl === DEFAULT_BASE_URL;
  if (isDefaultApi && !apiKey) {
    throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY.");
  }
  const schema = {
    name: "intervals_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["interval", "set"] },
              label: { type: "string" },
              durationSec: { type: "number" },
              repeat: { type: "number" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    durationSec: { type: "number" },
                  },
                  required: ["label", "durationSec"],
                },
              },
            },
            required: ["type", "label"],
          },
        },
      },
      required: ["blocks"],
    },
  };

  const payload = {
    model:
      options?.model ||
      process.env.EXPO_PUBLIC_OPENAI_TEXT_MODEL ||
      "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_schema", json_schema: schema },
    messages: [
      {
        role: "system",
        content:
          "Convert the user's workout description into a JSON object with a blocks array. " +
          "A block is either type 'interval' with label and durationSec, or type 'set' with label, repeat, and items array. " +
          "For sets like '8 sets of 30 seconds sprint followed by 90 seconds jog', create a set block with repeat=8 and two items. " +
          "Durations must be in seconds.",
      },
      { role: "user", content: input },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "AI parsing failed.");
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI parsing returned no content.");
  }

  const parsed = JSON.parse(content);
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  return normalizeBlocks(blocks);
}

export async function transcribeAudio(uri: string): Promise<string> {
  const apiKey = getApiKey();
  const url = `${getBaseUrl()}/audio/transcriptions`;
  if (!apiKey) {
    throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY.");
  }
  const form = new FormData();
  form.append("model", process.env.EXPO_PUBLIC_OPENAI_STT_MODEL || DEFAULT_TRANSCRIBE_MODEL);
  form.append("file", {
    uri,
    name: "workout.m4a",
    type: "audio/m4a",
  } as unknown as Blob);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Transcription failed.");
  }
  return data.text || "";
}
