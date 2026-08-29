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
import { getBrowserSupabase } from "@web/lib/auth/client";

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
      className="h-full overflow-y-auto overflow-x-hidden bg-[#090b0f] text-zinc-100"
      style={{ colorScheme: "dark" }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-12">
        <header className="flex items-center justify-between border-b border-zinc-800/80 pb-5">
          <div className="flex items-center gap-3 text-sm font-semibold text-white">
            <span className="grid h-8 w-8 place-items-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <span>个人助手</span>
          </div>
        </header>

        <div className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-20 lg:py-14">
          <aside className="hidden max-w-lg lg:block">
            <p className="flex items-center gap-3 text-xs font-medium text-zinc-500">
              <span className="h-px w-8 bg-cyan-400" aria-hidden="true" />
              懂你的智能助手
            </p>
            <h2 className="mt-6 text-[34px] font-semibold leading-[1.35] text-zinc-100">
              让思考，在每一次
              <br />
              对话中延续。
            </h2>
            <div className="mt-10 flex h-28 w-64 items-end gap-3 border-b border-zinc-800 pb-4" aria-hidden="true">
              <span className="h-7 w-1 bg-zinc-700" />
              <span className="h-12 w-1 bg-zinc-600" />
              <span className="h-9 w-1 bg-cyan-700" />
              <span className="h-16 w-1 bg-cyan-500" />
              <span className="h-11 w-1 bg-zinc-600" />
              <span className="h-20 w-1 bg-emerald-500" />
              <span className="h-14 w-1 bg-zinc-700" />
              <span className="h-24 w-1 bg-cyan-300" />
            </div>
          </aside>

          <section className="w-full">
            <form
              onSubmit={submit}
              className="mx-auto w-full max-w-[420px] rounded-lg border border-zinc-800 bg-[#11141a] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] sm:p-8"
            >
              <header>
                <p className="text-xs font-medium text-cyan-400">
                  {mode === "login" ? "欢迎回来" : "创建账户"}
                </p>
                <h1 className="mt-2 text-2xl font-semibold text-white">
                  {mode === "login" ? "登录个人空间" : "开始使用个人助手"}
                </h1>
                <p className="mt-2 text-sm leading-6 text-zinc-500">
                  {mode === "login" ? "输入账户信息以继续。" : "使用邮箱创建你的私人空间。"}
                </p>
              </header>

              <div className="mt-6 grid grid-cols-2 rounded-md bg-[#0b0e13] p-1 text-sm" aria-label="账户操作">
                <button
                  type="button"
                  aria-pressed={mode === "login"}
                  onClick={() => switchMode("login")}
                  className={`h-9 rounded transition-colors ${
                    mode === "login"
                      ? "bg-zinc-800 font-medium text-white shadow-sm"
                      : "text-zinc-500 hover:text-zinc-200"
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
                      ? "bg-zinc-800 font-medium text-white shadow-sm"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  注册
                </button>
              </div>

              <div className="mt-6 space-y-4">
                <div>
                  <label htmlFor="auth-email" className="block text-sm font-medium text-zinc-300">
                    邮箱地址
                  </label>
                  <div className="relative mt-2">
                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <input
                      id="auth-email"
                      type="email"
                      required
                      inputMode="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com"
                      className="h-12 w-full rounded-md border border-zinc-700 bg-[#0b0e13] pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-zinc-600 hover:border-zinc-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="auth-password" className="block text-sm font-medium text-zinc-300">
                    密码
                  </label>
                  <div className="relative mt-2">
                    <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <input
                      id="auth-password"
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={6}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 6 位字符"
                      className="h-12 w-full rounded-md border border-zinc-700 bg-[#0b0e13] pl-11 pr-12 text-sm text-white outline-none transition placeholder:text-zinc-600 hover:border-zinc-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      title={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" /> : <Eye className="h-[18px] w-[18px]" aria-hidden="true" />}
                    </button>
                  </div>
                </div>

                {mode === "signup" && (
                  <div>
                    <label htmlFor="auth-confirm-password" className="block text-sm font-medium text-zinc-300">
                      确认密码
                    </label>
                    <div className="relative mt-2">
                      <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                      <input
                        id="auth-confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        required
                        minLength={6}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        placeholder="再次输入密码"
                        className="h-12 w-full rounded-md border border-zinc-700 bg-[#0b0e13] pl-11 pr-12 text-sm text-white outline-none transition placeholder:text-zinc-600 hover:border-zinc-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/15"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((value) => !value)}
                        className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
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
                <div role="alert" className="mt-4 rounded-md border border-rose-900/80 bg-rose-950/40 px-3.5 py-3 text-sm text-rose-300">
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
                <div role="status" className="mt-4 flex items-start gap-2.5 rounded-md border border-emerald-900/80 bg-emerald-950/40 px-3.5 py-3 text-sm text-emerald-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{message}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-md bg-cyan-400 px-4 text-sm font-semibold text-[#071014] transition-colors hover:bg-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-[#11141a] disabled:cursor-not-allowed disabled:opacity-60"
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

              <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-zinc-500">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <span>账户数据仅用于你的个人空间</span>
              </p>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function LoginFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[#090b0f] text-zinc-500" style={{ colorScheme: "dark" }}>
      <div className="flex items-center gap-2 text-sm">
        <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>正在加载...</span>
      </div>
    </div>
  );
}
