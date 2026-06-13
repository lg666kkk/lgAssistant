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
  const missingGroups = [
    process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY ? null : 'DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY',
  ].filter(Boolean);

  if (missing.length > 0 || missingGroups.length > 0) {
    throw new Error(
      `缺少必需的环境变量: ${[...missing, ...missingGroups].join(', ')}\n` +
      `请检查 .env.local 文件是否正确配置`
    );
  }
}

// 在服务端启动时验证环境变量
if (typeof window === 'undefined') {
  validateEnv();
}

/**
 * DeepSeek API 配置
 */
export const deepseekConfig = {
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY!,
  baseURL: process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-pro',
  maxTokens: 4096,
  temperature: 0.7,
} as const;

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
  maxResults: 5,              // 最多返回结果数

  // 上下文配置
  maxContextLength: 2000,     // 最大上下文长度（字符）
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
