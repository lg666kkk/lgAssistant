/**
 * 会话持久化模块
 * 负责会话和消息的数据库操作
 */

import { getBrowserSupabase } from './auth/client';

/**
 * 会话类型
 */
export interface Session {
  id: string;
  user_id?: string;
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
  user_id?: string;
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
 * 会话管理类
 */
export class SessionManager {
  private supabase = getBrowserSupabase() as any;

  private async getUserId(): Promise<string> {
    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser();

    if (error || !user) {
      throw new Error('请先登录');
    }

    return user.id;
  }

  /**
   * 获取所有会话列表（按更新时间倒序）
   */
  async getSessions(): Promise<Session[]> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // 确认/取消工具后，把新的 toolCalls 写回当前 assistant 消息的 metadata。
  async updateMessageMetadata(messageId: string, metadata: any): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from('messages')
      .update({ metadata })
      .eq('user_id', userId)
      .eq('id', messageId);
    if (error) throw error;
  }

  /**
   * 创建新会话
   */
  async createSession(title = '新对话', id?: string): Promise<Session> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('sessions')
      .insert(id ? { id, title, user_id: userId } : { title, user_id: userId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * 更新会话标题
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from('sessions')
      .update({ title })
      .eq('user_id', userId)
      .eq('id', sessionId);

    if (error) throw error;
  }

  async updateSystemPrompt(sessionId: string, systemPrompt: string): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from('sessions')
      .update({ system_prompt: systemPrompt })
      .eq('user_id', userId)
      .eq('id', sessionId);

    if (error) throw error;
  }

  /**
   * 删除会话（会级联删除所有消息）
   */
  async deleteSession(sessionId: string): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from('sessions')
      .delete()
      .eq('user_id', userId)
      .eq('id', sessionId);

    if (error) throw error;
  }

  /**
   * 获取会话的所有消息
   */
  async getMessages(sessionId: string): Promise<Message[]> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('messages')
      .select('*')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * 保存用户消息
   */
  async saveUserMessage(sessionId: string, content: string): Promise<Message> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        user_id: userId,
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
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        user_id: userId,
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
