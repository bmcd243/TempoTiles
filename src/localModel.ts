import { IntervalBlock } from "./types";
import { requireOptionalNativeModule } from "expo-modules-core";

type LocalModelModule = {
  ensureModelDownloaded: (url: string) => Promise<string>;
  isModelReady: () => Promise<boolean>;
  runInference: (prompt: string) => Promise<string>;
};

const LocalModel = requireOptionalNativeModule("LocalModel") as
  | LocalModelModule
  | null;

export const isOnDeviceModuleAvailable = !!LocalModel;

function safeParseBlocks(payload: string): IntervalBlock[] {
  const parsed = JSON.parse(payload);
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  return blocks.map((block, index) => ({
    ...block,
    id: block.id || `local_${index}_${Date.now()}`,
  }));
}

export async function ensureOnDeviceModel(url: string) {
  if (!LocalModel) return;
  await LocalModel.ensureModelDownloaded(url);
}

export async function runOnDeviceParse(input: string): Promise<IntervalBlock[]> {
  if (!LocalModel) {
    throw new Error("On-device model is not available in this build.");
  }
  const json = await LocalModel.runInference(input);
  return safeParseBlocks(json);
}
