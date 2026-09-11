"use client";

import {
  createContext,
  useCallback,
  Fragment,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { getBrowserSupabase, LOGIN_REQUIRED_EVENT } from "./client";

import { AuthDialog } from "./auth-dialog";

type AuthContextValue = {
  requestLogin: () => void;
  requireLogin: () => boolean;
  user: User | null;
  loading: boolean;
  supabase: ReturnType<typeof getBrowserSupabase>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loginOpen, setLoginOpen] = useState(false);
  const closeLogin = useCallback(() => setLoginOpen(false), []);
  const requestLogin = useCallback(() => setLoginOpen(true), []);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => getBrowserSupabase(), []);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    const handleLoginRequired = () => {
      // A rejected session must not keep private panels mounted, even if sign-out failed.
      setUser(null);
      requestLogin();
    };
    window.addEventListener(LOGIN_REQUIRED_EVENT, handleLoginRequired);
    return () => window.removeEventListener(LOGIN_REQUIRED_EVENT, handleLoginRequired);
  }, [requestLogin]);

  useEffect(() => { if (user) setLoginOpen(false); }, [user]);
  const requireLogin = useCallback(() => {
    if (user) return true;
    requestLogin();
    return false;
  }, [user, requestLogin]);

  const value = useMemo(
    () => ({ user, loading, supabase, requestLogin, requireLogin }),
    [loading, supabase, user, requestLogin, requireLogin],
  );

  return createElement(AuthContext.Provider, { value },
    createElement(Fragment, null, children, loginOpen && !user ? createElement(AuthDialog, { onClose: closeLogin }) : null));
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return value;
}
