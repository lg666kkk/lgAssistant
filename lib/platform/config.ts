/**
 * 应用配置模块
 * 集中管理所有配置项，包括模型设置、API 配置等
 */

/**
 * 验证必需的环境变量
 */
function validateEnv() {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];

  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `缺少必需的环境变量: ${missing.join(', ')}\n` +
      `请检查 .env.local 文件是否正确配置`
    );
  }
}

// 在服务端启动时验证环境变量
if (typeof window === 'undefined') {
  validateEnv();
}

/**
 * Supabase 配置
 */
export const supabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
} as const;

/**
 * RAG 配置
 */
export const ragConfig = {
  // 向量检索配置
  similarityThreshold: 0.5,  // 相似度阈值
  fallbackSimilarityThreshold: 0.4, // 首次无结果时允许的最低二级阈值，禁止降到 0
  fallbackMinEvidenceScore: 0.28, // 二级召回结果必须达到的综合证据分
  fallbackMaxResults: 3,      // 低置信召回只保留少量最相关结果
  maxResults: 5,              // 最多返回结果数
  candidateMultiplier: 4,     // 粗召回候选倍数
  maxCandidates: 50,          // 融合后进入 rerank/MMR 的候选池硬上限
  fusionStrategy: process.env.RAG_FUSION_STRATEGY === 'weighted' ? 'weighted' : 'rrf',
  rrfK: 60,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  dynamicFusionWeights: true,

  // 条件式 Cross-Encoder。未配置 endpoint/model 时保持规则重排。
  crossEncoderEnabled: process.env.RAG_CROSS_ENCODER_ENABLED === 'true',
  crossEncoderMode: process.env.RAG_CROSS_ENCODER_MODE === 'always' ? 'always' : 'conditional',
  crossEncoderCandidateCount: 12,
  crossEncoderScoreGapThreshold: 0.08,
  crossEncoderLowScoreThreshold: 0.45,

  // 上下文配置
  maxContextLength: 2000,     // 最大上下文长度（字符）
  maxContextTokens: 2400,     // 工具最终投喂给模型的 token 硬预算
  parentContextMaxChars: 1800,
} as const;

/**
 * 应用配置
 */
export const appConfig = {
  // 会话配置
  defaultSessionTitle: '新对话',

  // UI 配置
  maxMessageLength: 4000,     // 最大消息长度
} as const;
