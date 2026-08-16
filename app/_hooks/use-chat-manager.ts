import { useState, useCallback, useRef, useEffect } from "react";
import { ChatSession } from "@/lib/chat/chat-session";
import { SessionManager } from "@/lib/chat/session-manager";
import { useAuth } from "@/lib/auth/use-auth";

export function useChatManager() {
  const { user, loading: authLoading } = useAuth();
  const sessionsRef = useRef<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [, forceUpdate] = useState(0);
  const [loading, setLoading] = useState(true);

  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  // 从数据库加载会话列表
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;

    if (!user) {
      sessionsRef.current = [];
      setActiveId("");
      setLoading(false);
      rerender();
      return;
    }

    setLoading(true);
    const loadSessions = async () => {
      try {
        const sessionManager = new SessionManager(user.id);
        const dbSessions = await sessionManager.getSessions();
        if (cancelled) return;

        if (dbSessions.length > 0) {
          const sessions = dbSessions.map((dbSession) => {
            const session = new ChatSession(dbSession.id, user.id);
            session.title = dbSession.title;
            session.contextUsage = dbSession.metadata?.contextUsage ?? null;
            return session;
          });
          sessionsRef.current = sessions;
          setActiveId(sessions[0].id);
          // 首屏只取当前会话最近一页；其余会话在用户切换时再加载。
          await sessions[0].loadFromDatabase();
        } else {
          // 没有会话，创建一个新的
          const session = new ChatSession(undefined, user.id);
          sessionsRef.current = [session];
          setActiveId(session.id);
        }
      } catch (error) {
        if (cancelled) return;
        console.error('加载会话失败:', error);
        // 加载失败，创建一个新会话
        const session = new ChatSession(undefined, user.id);
        sessionsRef.current = [session];
        setActiveId(session.id);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadSessions();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user?.id, rerender]);

  const sessions = sessionsRef.current;
  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];

  const createSession = useCallback(() => {
    const session = new ChatSession(undefined, user?.id);
    sessionsRef.current = [session, ...sessionsRef.current];
    setActiveId(session.id);
    rerender();
  }, [rerender, user?.id]);

  const moveSessionToTop = useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session || sessionsRef.current[0]?.id === id) return;

      sessionsRef.current = [
        session,
        ...sessionsRef.current.filter((s) => s.id !== id),
      ];
      rerender();
    },
    [rerender],
  );

  const switchSession = useCallback((id: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === id);
    if (!session) return;
    setActiveId(id);
    rerender();
    void session.loadFromDatabase().finally(rerender);
  }, [rerender]);

  const deleteSession = useCallback(
    async (id: string) => {
      const list = sessionsRef.current;
      if (list.length <= 1) {
        throw new Error("至少需要保留一个会话");
      }

      const target = list.find((s) => s.id === id);
      target?.abort();

      const sessionManager = new SessionManager(user?.id);
      await sessionManager.deleteSession(id);

      const remainingSessions = list.filter((s) => s.id !== id);
      sessionsRef.current = remainingSessions.length > 0
        ? remainingSessions
        : [new ChatSession(undefined, user?.id)];
      if (activeId === id) {
        setActiveId(sessionsRef.current[0].id);
      }
      rerender();
    },
    [activeId, rerender, user?.id],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const normalizedTitle = title.trim().replace(/\s+/g, " ");
      if (!normalizedTitle) throw new Error("会话名称不能为空");
      if (normalizedTitle.length > 60) throw new Error("会话名称不能超过 60 个字符");

      const session = sessionsRef.current.find((candidate) => candidate.id === id);
      if (!session) throw new Error("会话不存在或已被删除");
      if (session.title === normalizedTitle) return;

      const sessionManager = new SessionManager(user?.id);
      await sessionManager.updateSessionTitle(id, normalizedTitle);
      session.title = normalizedTitle;
      rerender();
    },
    [rerender, user?.id],
  );
  return {
    sessions,
    activeId,
    activeSession,
    createSession,
    moveSessionToTop,
    switchSession,
    deleteSession,
    renameSession,
    rerender,
    loading,
  };
}
