export type ChatModelId =
  | "deepseek-v4-pro"
  | "deepseek-v4-flash";

export type ChatModelOption = {
  id: ChatModelId;
  name: string;
  description: string;
  badge?: string;
};

export const chatModelOptions: ChatModelOption[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "默认模型，适合通用对话和工具调用",
    badge: "默认",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "轻量通用模型，适合日常问答",
  }
];

export const defaultChatModel: ChatModelId = "deepseek-v4-pro";

export function resolveChatModel(model: unknown): ChatModelId {
  return chatModelOptions.some((option) => option.id === model)
    ? (model as ChatModelId)
    : defaultChatModel;
}

export function getChatModelOption(model: ChatModelId) {
  return chatModelOptions.find((option) => option.id === model);
}
