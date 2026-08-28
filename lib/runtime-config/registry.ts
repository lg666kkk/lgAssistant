export type RuntimeConfigDefinition = {
  key: string;
  label: string;
  group: string;
  description: string;
  secret: boolean;
  type: "text" | "select";
  options?: string[];
  environmentKey?: string;
  surface?: "settings" | "langfuse";
};

export const runtimeConfigDefinitions: RuntimeConfigDefinition[] = [
  {
    key: "DASHSCOPE_BASE_URL",
    label: "DashScope Base URL",
    group: "Embedding",
    description: "OpenAI 兼容的 DashScope 接口地址。",
    secret: false,
    type: "text",
    environmentKey: "DASHSCOPE_BASE_URL",
  },
  {
    key: "DASHSCOPE_API_KEY",
    label: "DashScope API Key",
    group: "Embedding",
    description: "检索与知识同步使用的 Embedding 密钥。",
    secret: true,
    type: "text",
    environmentKey: "DASHSCOPE_API_KEY",
  },
  {
    key: "RAG_FUSION_STRATEGY",
    label: "检索融合策略",
    group: "检索",
    description: "向量和关键词召回结果的融合方式。",
    secret: false,
    type: "select",
    options: ["rrf", "weighted"],
    environmentKey: "RAG_FUSION_STRATEGY",
  },
  {
    key: "RAG_CROSS_ENCODER_ENABLED",
    label: "启用 Cross-Encoder",
    group: "检索",
    description: "候选证据不确定时启用二阶段重排。",
    secret: false,
    type: "select",
    options: ["true", "false"],
    environmentKey: "RAG_CROSS_ENCODER_ENABLED",
  },
];

export function getRuntimeConfigDefinition(key: string) {
  return runtimeConfigDefinitions.find((definition) => definition.key === key);
}
