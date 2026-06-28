"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/auth/client";

function isValidEmail(value: string) {
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAuthErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();

  if (normalized.includes("email rate limit exceeded")) {
    return "邮件发送太频繁了，请稍后再试。开发阶段可以先关闭邮箱确认，或在 Supabase 配置自定义 SMTP。";
  }

  if (normalized.includes("email not confirmed")) {
    return "邮箱还没有确认，请先去邮箱点击确认链接。";
  }

  if (normalized.includes("invalid login credentials")) {
    return "邮箱或密码不正确。";
  }

  return message || "登录失败";
}

export default function LoginPage() {
  const router = useRouter();
  const supabase = getBrowserSupabase();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace("/");
    });
  }, [router, supabase.auth]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const normalizedEmail = email.trim();
      if (!isValidEmail(normalizedEmail)) {
        throw new Error("请输入有效的邮箱地址");
      }

      if (mode === "signup" && password !== confirmPassword) {
        throw new Error("两次输入的密码不一致");
      }

      const result =
        mode === "login"
          ? await supabase.auth.signInWithPassword({ email: normalizedEmail, password })
          : await supabase.auth.signUp({ email: normalizedEmail, password });

      if (result.error) throw result.error;

      if (mode === "signup" && !result.data.session) {
        setMessage("注册成功，请到邮箱确认后再登录。");
      } else {
        router.replace("/");
      }
    } catch (e) {
      setError(getAuthErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function resendConfirmation() {
    const normalizedEmail = email.trim();
    if (!isValidEmail(normalizedEmail)) {
      setError("请输入有效的邮箱地址");
      return;
    }

    setResending(true);
    setError(null);
    setMessage(null);

    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: normalizedEmail,
      });
      if (resendError) throw resendError;
      setMessage("确认邮件已重新发送，请检查邮箱。");
    } catch (e) {
      setError(getAuthErrorMessage(e));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-200">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold text-white">
          {mode === "login" ? "登录" : "注册"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">使用 Supabase Auth 管理个人数据空间。</p>

        <label className="mt-6 block text-sm text-slate-300">
          邮箱
          <input
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
          />
        </label>

        <label className="mt-4 block text-sm text-slate-300">
          密码
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
          />
        </label>

        {mode === "signup" && (
          <label className="mt-4 block text-sm text-slate-300">
            确认密码
            <input
              type="password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
            />
          </label>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
            {error}
            {error.toLowerCase().includes("email not confirmed") && (
              <button
                type="button"
                onClick={resendConfirmation}
                disabled={resending}
                className="mt-3 block text-sm text-rose-100 underline underline-offset-4 hover:text-white disabled:cursor-not-allowed disabled:text-rose-500"
              >
                {resending ? "正在重发..." : "重发确认邮件"}
              </button>
            )}
          </div>
        )}
        {message && <div className="mt-4 rounded-md border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{message}</div>}

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "处理中..." : mode === "login" ? "登录" : "注册"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode((value) => (value === "login" ? "signup" : "login"));
            setConfirmPassword("");
            setError(null);
            setMessage(null);
          }}
          className="mt-4 w-full text-sm text-slate-400 hover:text-slate-200"
        >
          {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
        </button>
      </form>
    </div>
  );
}
