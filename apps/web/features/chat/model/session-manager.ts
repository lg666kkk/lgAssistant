/**
 * 会话持久化模块
 * 负责会话和消息的数据库操作
 */

import { authFetch, getBrowserSupabase } from "@web/lib/auth/client";
import type { ChatImageAttachment } from "@/lib/agent/multimodal";
import type { ContextUsageEventData } from "@repo/contracts";
import {
  applyChatImageSignedUrls,
  createChatImageSignedUrlMap,
  deleteChatImages,
} from "@/lib/chat/image-storage";

/**
 * 会话类型
 */
export interface Session {
  id: string;
  user_id?: string;
  title: string;
  model: string;
  system_prompt: string | null;
  metadata?: {
    contextUsage?: ContextUsageEventData;
  };
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

  constructor(private userId?: string) {}

  private async getUserId(): Promise<string> {
    if (this.userId) return this.userId;

    const {
      data: { session },
      error,
    } = await this.supabase.auth.getSession();
    const user = session?.user;

    if (error || !user) {
      throw new Error('请先登录');
    }

    this.userId = user.id;
    return user.id;
  }

  /**
   * 获取所有会话列表（按更新时间倒序）
   */
  async getSessions(): Promise<Session[]> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('sessions')
      .select('id,title,model,system_prompt,metadata,created_at,updated_at')
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

  async updateSessionContextUsage(
    sessionId: string,
    contextUsage: ContextUsageEventData,
  ): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from("sessions")
      .update({ metadata: { contextUsage } })
      .eq("user_id", userId)
      .eq("id", sessionId);

    if (error) throw error;
  }

  /**
   * 删除会话（会级联删除所有消息，并清理 Redis 与本地 tool artifact）
   */
  async deleteSession(sessionId: string): Promise<void> {
    const response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (response.ok) return;

    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "删除会话失败");
  }

  async deleteChatImagePaths(paths: string[]): Promise<void> {
    await deleteChatImages(this.supabase, paths);
  }

  /**
   * 获取会话的所有消息
   */
  async getMessages(
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<Message[]> {
    const userId = await this.getUserId();
    const limit = options.limit ?? 50;
    let query = this.supabase
      .from('messages')
      .select('id,session_id,role,content,sources,model,tokens_used,metadata,created_at')
      .eq('user_id', userId)
      .eq('session_id', sessionId);
    if (options.before) query = query.lt('created_at', options.before);

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    const messages = (data || []).reverse() as Message[];
    const storagePaths = messages.flatMap((message) => {
      const attachments = message.metadata?.attachments;
      if (!Array.isArray(attachments)) return [];
      return attachments.flatMap((attachment: ChatImageAttachment) =>
        typeof attachment?.storagePath === "string" ? [attachment.storagePath] : []);
    });
    if (storagePaths.length === 0) return messages;

    try {
      const signedUrls = await createChatImageSignedUrlMap(this.supabase, {
        userId,
        sessionId,
        paths: storagePaths,
      });
      return messages.map((message) => {
        const attachments = message.metadata?.attachments;
        if (!Array.isArray(attachments)) return message;
        return {
          ...message,
          metadata: {
            ...message.metadata,
            attachments: applyChatImageSignedUrls(attachments, signedUrls),
          },
        };
      });
    } catch (storageError) {
      console.error("加载历史图片失败:", storageError);
      return messages;
    }
  }

  /**
   * 保存用户消息
   */
  async saveUserMessage(
    sessionId: string,
    content: string,
    options: { metadata?: any } = {},
  ): Promise<Message> {
    const userId = await this.getUserId();
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        user_id: userId,
        session_id: sessionId,
        role: 'user',
        content,
        metadata: options.metadata,
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
