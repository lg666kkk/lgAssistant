import type { LlmReasoningMode } from "./types";

export type ThinkingMode = "default" | "on" | "off";
export type ThinkingProtocol = "auto" | "deepseek" | "qwen" | "thinking";

export function readThinkingSelection(mode: LlmReasoningMode): { mode: ThinkingMode; protocol: ThinkingProtocol } {
  if (mode === "none") return { mode: "default", protocol: "auto" };
  if (mode === "auto-on" || mode === "auto-off") return { mode: mode === "auto-on" ? "on" : "off", protocol: "auto" };
  return { mode: mode.endsWith("-off") ? "off" : "on", protocol: mode.replace(/-off$/, "") as ThinkingProtocol };
}

export function writeThinkingSelection(mode: ThinkingMode, protocol: ThinkingProtocol): LlmReasoningMode {
  if (mode === "default") return "none";
  if (protocol === "auto") return mode === "on" ? "auto-on" : "auto-off";
  return `${protocol}${mode === "off" ? "-off" : ""}` as LlmReasoningMode;
}

export function detectThinkingProtocol(baseUrl: string, modelId: string): Exclude<ThinkingProtocol, "auto"> | null {
  let host = "";
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* A draft URL may be incomplete. */ }
  const matchesHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  const model = modelId.toLowerCase().split("/").pop() ?? "";
  const qwen = /^qwen3(?:[.\-]|$)/.test(model);
  const deepseek = /^deepseek-v(?:3\.[12]|4)(?:[.\-]|$)/.test(model);
  const thinking = /^(?:kimi-k(?:2\.5|3)|glm-(?:4\.[567]|5))(?:[.\-]|$)/.test(model);
  // Alibaba's gateway uses enable_thinking even for non-Qwen model families.
  if ((qwen || deepseek) && (matchesHost("aliyuncs.com") || matchesHost("qwen.ai"))) return "qwen";
  if (qwen) return "qwen";
  if (deepseek) return "deepseek";
  if (thinking) return "thinking";
  return null;
}

export function supportsThinkingOff(modelId: string) {
  const model = modelId.toLowerCase().split("/").pop() ?? "";
  return !/^(?:glm-5\.3(?:[.\-]|$)|deepseek-r1(?:[.\-]|$)|kimi-k2-thinking(?:[.\-]|$))/.test(model);
}

export function resolveThinkingMode(mode: LlmReasoningMode, baseUrl: string, modelId: string): LlmReasoningMode {
  const selection = readThinkingSelection(mode);
  if (selection.mode === "default") return "none";
  if (selection.mode === "off" && !supportsThinkingOff(modelId)) {
    throw new Error(`${modelId} 不支持关闭思考，请选择默认或开启。`);
  }
  if (selection.protocol !== "auto") return mode;
  const protocol = detectThinkingProtocol(baseUrl, modelId);
  return protocol ? writeThinkingSelection(selection.mode, protocol) : "none";
}
