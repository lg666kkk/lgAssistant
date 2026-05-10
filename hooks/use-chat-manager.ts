import { useState, useCallback, useRef } from "react";
import { ChatSession } from "@/lib/chat-session";

export function useChatManager() {
  const sessionsRef = useRef<ChatSession[]>([new ChatSession()]);
  const [activeId, setActiveId] = useState(sessionsRef.current[0].id);
  const [, forceUpdate] = useState(0);

  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

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
    (id: string) => {
      const list = sessionsRef.current;
      if (list.length <= 1) return;
      const target = list.find((s) => s.id === id);
      target?.abort();
      sessionsRef.current = list.filter((s) => s.id !== id);
      if (activeId === id) {
        setActiveId(sessionsRef.current[0].id);
      }
      rerender();
    },
    [activeId, rerender],
  );

  return {
    sessions,
    activeId,
    activeSession,
    createSession,
    switchSession,
    deleteSession,
    rerender,
  };
}
