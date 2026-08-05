"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
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

function getSafeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = getBrowserSupabase();
  const nextPath = getSafeNextPath(searchParams.get("next"));
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace(nextPath);
    });
  }, [nextPath, router, supabase.auth]);

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
        router.replace(nextPath);
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

  function switchMode(nextMode: "login" | "signup") {
    if (mode === nextMode) return;
    setMode(nextMode);
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirmPassword(false);
    setError(null);
    setMessage(null);
  }

  return (
    <main
      className="grid h-[100dvh] overflow-y-auto overflow-x-hidden bg-slate-950 text-slate-100 lg:grid-cols-[minmax(0,1.04fr)_minmax(420px,0.96fr)]"
      style={{ colorScheme: "dark" }}
    >
      <aside className="relative hidden min-h-full overflow-hidden border-r border-slate-800 bg-slate-900 p-10 text-white lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div className="relative z-10 flex items-center gap-3 text-sm font-semibold">
          <span className="grid h-5 w-5 place-items-center border border-cyan-400/40 bg-cyan-400/10 text-cyan-300">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
          </span>
          <span>个人智能助手</span>
        </div>

        <div className="relative z-10 max-w-md">
          <p className="text-xs font-medium text-cyan-300/70">PRIVATE WORKSPACE / 01</p>
          <p className="mt-5 text-4xl font-semibold leading-[1.35] xl:text-[42px]">
            让思考，在每一次
            <br />
            对话中延续。
          </p>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-xs text-slate-500">
          <LockKeyhole className="h-4 w-4" aria-hidden="true" />
          <span>私人空间 · 安全访问</span>
        </div>

        <div className="pointer-events-none absolute -right-20 top-1/2 h-64 w-64 -translate-y-1/2 rotate-45 border border-cyan-400/10" />
        <div className="pointer-events-none absolute -right-10 top-1/2 h-44 w-44 -translate-y-1/2 rotate-45 border border-cyan-400/10" />
      </aside>

      <section className="flex min-h-full items-center justify-center px-5 py-7 sm:px-10 lg:px-12 xl:px-20">
        <form onSubmit={submit} className="w-full max-w-[420px]">
          <div className="mb-12 flex items-center gap-3 text-sm font-semibold text-white lg:hidden">
            <span className="grid h-10 w-10 place-items-center border border-cyan-400/40 bg-cyan-400/10 text-cyan-300">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <span>Personal Assistant</span>
          </div>

          <header>
            <p className="text-xs font-semibold text-cyan-400/70">
              {mode === "login" ? "WELCOME BACK" : "CREATE YOUR SPACE"}
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-white sm:text-[28px]">
              {mode === "login" ? "登录你的工作空间" : "创建你的工作空间"}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              {mode === "login" ? "使用你的账户继续" : "注册账户，开始新的对话"}
            </p>
          </header>

          <div className="mt-7 grid grid-cols-2 rounded-md border border-slate-800 bg-slate-900 p-1 text-sm" aria-label="账户操作">
            <button
              type="button"
              aria-pressed={mode === "login"}
              onClick={() => switchMode("login")}
              className={`h-9 rounded transition-colors ${
                mode === "login"
                  ? "bg-slate-800 font-medium text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-200"
              }`}
            >
              登录
            </button>
            <button
              type="button"
              aria-pressed={mode === "signup"}
              onClick={() => switchMode("signup")}
              className={`h-9 rounded transition-colors ${
                mode === "signup"
                  ? "bg-slate-800 font-medium text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-200"
              }`}
            >
              注册
            </button>
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="auth-email" className="block text-sm font-medium text-slate-300">
                邮箱地址
              </label>
              <div className="relative mt-2">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input
                  id="auth-email"
                  type="email"
                  required
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  className="h-12 w-full rounded-md border border-slate-700 bg-slate-900 pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-slate-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                />
              </div>
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-sm font-medium text-slate-300">
                密码
              </label>
              <div className="relative mt-2">
                <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={6}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 6 位字符"
                  className="h-12 w-full rounded-md border border-slate-700 bg-slate-900 pl-11 pr-12 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-slate-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" /> : <Eye className="h-[18px] w-[18px]" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {mode === "signup" && (
              <div>
                <label htmlFor="auth-confirm-password" className="block text-sm font-medium text-slate-300">
                  确认密码
                </label>
                <div className="relative mt-2">
                  <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input
                    id="auth-confirm-password"
                    type={showConfirmPassword ? "text" : "password"}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="再次输入密码"
                    className="h-12 w-full rounded-md border border-slate-700 bg-slate-900 pl-11 pr-12 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-slate-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((value) => !value)}
                    className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
                    aria-label={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"}
                    title={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"}
                  >
                    {showConfirmPassword ? <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" /> : <Eye className="h-[18px] w-[18px]" aria-hidden="true" />}
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="mt-4 rounded-md border border-rose-900 bg-rose-950/50 px-3.5 py-3 text-sm text-rose-300">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
              {error.includes("邮箱还没有确认") && (
                <button
                  type="button"
                  onClick={resendConfirmation}
                  disabled={resending}
                  className="ml-6 mt-2 text-sm font-medium text-rose-200 underline underline-offset-4 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resending ? "正在重发..." : "重发确认邮件"}
                </button>
              )}
            </div>
          )}

          {message && (
            <div role="status" className="mt-4 flex items-start gap-2.5 rounded-md border border-emerald-900 bg-emerald-950/50 px-3.5 py-3 text-sm text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{message}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>处理中...</span>
              </>
            ) : (
              <>
                <span>{mode === "login" ? "登录" : "创建账户"}</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </>
            )}
          </button>

          <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>你的个人数据仅用于当前账户</span>
          </p>
        </form>
      </section>
    </main>
  );
}

function LoginFallback() {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-slate-950 text-slate-500" style={{ colorScheme: "dark" }}>
      <div className="flex items-center gap-2 text-sm">
        <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>正在加载...</span>
      </div>
    </div>
  );
}
