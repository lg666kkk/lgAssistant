/**
 * 会话持久化模块
 * 负责会话和消息的数据库操作
 */

import { createClient } from '@supabase/supabase-js';

/**
 * 会话类型
 */
export interface Session {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 消息类型
 */
export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: any[];
  model?: string;
  tokens_used?: number;
  metadata?: any;
  created_at: string;
}

/**
 * 创建浏览器端 Supabase 客户端
 */
function createBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('缺少 Supabase 环境变量');
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

/**
 * 会话管理类
 */
export class SessionManager {
  private supabase = createBrowserClient();

  /**
   * 获取所有会话列表（按更新时间倒序）
   */
  async getSessions(): Promise<Session[]> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * 创建新会话
   */
  async createSession(title = '新对话'): Promise<Session> {
    const { data, error } = await this.supabase
      .from('sessions')
      .insert({ title })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * 更新会话标题
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .update({ title })
      .eq('id', sessionId);

    if (error) throw error;
  }

  /**
   * 删除会话（会级联删除所有消息）
   */
  async deleteSession(sessionId: string): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (error) throw error;
  }

  /**
   * 获取会话的所有消息
   */
  async getMessages(sessionId: string): Promise<Message[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * 保存用户消息
   */
  async saveUserMessage(sessionId: string, content: string): Promise<Message> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role: 'user',
        content,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * 保存 AI 回复消息
   */
  async saveAssistantMessage(
    sessionId: string,
    content: string,
    options: {
      sources?: any[];
      model?: string;
      tokens_used?: number;
      metadata?: any;
    } = {}
  ): Promise<Message> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content,
        sources: options.sources,
        model: options.model,
        tokens_used: options.tokens_used,
        metadata: options.metadata,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
