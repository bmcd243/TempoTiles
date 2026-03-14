import { IntervalBlock } from "./types";
import { requireNativeModule } from "expo-modules-core";

type LocalModelModule = {
  ensureModelDownloaded: (url: string) => Promise<string>;
  isModelReady: () => Promise<boolean>;
  runInference: (prompt: string) => Promise<string>;
};

const LocalModel = requireNativeModule("LocalModel") as LocalModelModule;

function safeParseBlocks(payload: string): IntervalBlock[] {
  const parsed = JSON.parse(payload);
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  return blocks.map((block, index) => ({
    ...block,
    id: block.id || `local_${index}_${Date.now()}`,
  }));
}

export async function ensureOnDeviceModel(url: string) {
  await LocalModel.ensureModelDownloaded(url);
}

export async function runOnDeviceParse(input: string): Promise<IntervalBlock[]> {
  const json = await LocalModel.runInference(input);
  return safeParseBlocks(json);
}
