import { useState, useCallback, useRef, useEffect } from "react";
import { ChatSession } from "@/lib/chat-session";
import { SessionManager } from "@/lib/session-manager";

export function useChatManager() {
  const sessionsRef = useRef<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [, forceUpdate] = useState(0);
  const [loading, setLoading] = useState(true);

  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  // 从数据库加载会话列表
  useEffect(() => {
    const loadSessions = async () => {
      try {
        const sessionManager = new SessionManager();
        const dbSessions = await sessionManager.getSessions();

        if (dbSessions.length > 0) {
          // 加载数据库中的会话
          const sessions = await Promise.all(
            dbSessions.map(async (dbSession) => {
              const session = new ChatSession(dbSession.id);
              session.title = dbSession.title;
              await session.loadFromDatabase();
              return session;
            })
          );
          sessionsRef.current = sessions;
          setActiveId(sessions[0].id);
        } else {
          // 没有会话，创建一个新的
          const session = new ChatSession();
          sessionsRef.current = [session];
          setActiveId(session.id);
        }
      } catch (error) {
        console.error('加载会话失败:', error);
        // 加载失败，创建一个新会话
        const session = new ChatSession();
        sessionsRef.current = [session];
        setActiveId(session.id);
      } finally {
        setLoading(false);
      }
    };

    loadSessions();
  }, []);

  const sessions = sessionsRef.current;
  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];

  const createSession = useCallback(() => {
    const session = new ChatSession();
    sessionsRef.current.push(session);
    setActiveId(session.id);
    rerender();
  }, [rerender]);

  const switchSession = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      const list = sessionsRef.current;
      if (list.length <= 1) return;

      const target = list.find((s) => s.id === id);
      target?.abort();

      // 从数据库删除
      try {
        const sessionManager = new SessionManager();
        await sessionManager.deleteSession(id);
      } catch (error) {
        console.error('删除会话失败:', error);
      }

      sessionsRef.current = list.filter((s) => s.id !== id);
      if (activeId === id) {
        setActiveId(sessionsRef.current[0].id);
      }
      rerender();
    },
    [activeId, rerender],
  );
  console.log('2222', activeSession)
  return {
    sessions,
    activeId,
    activeSession,
    createSession,
    switchSession,
    deleteSession,
    rerender,
    loading,
  };
}
