"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Mail, Save, UserRound } from "lucide-react";
import { useAuth } from "@web/lib/auth/use-auth";

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500 disabled:text-slate-500";

export function AccountCenter() {
  const { user, supabase } = useAuth();
  const savedName = typeof user?.user_metadata?.display_name === "string"
    ? user.user_metadata.display_name as string
    : "";
  const [displayName, setDisplayName] = useState(savedName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [nameNotice, setNameNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setDisplayName(savedName); }, [savedName, user?.id]);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || name.length > 60) {
      setNameNotice({ ok: false, text: "显示名称需要 1 到 60 个字符" });
      return;
    }
    setSavingName(true);
    setNameNotice(null);
    try {
      const { error } = await supabase.auth.updateUser({ data: { display_name: name } });
      if (error) throw error;
      setDisplayName(name);
      setNameNotice({ ok: true, text: "显示名称已保存" });
    } catch (error) {
      setNameNotice({ ok: false, text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSavingName(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setPasswordNotice({ ok: false, text: "新密码至少需要 8 个字符" });
      return;
    }
    if (password !== confirmPassword) {
      setPasswordNotice({ ok: false, text: "两次输入的密码不一致" });
      return;
    }
    setSavingPassword(true);
    setPasswordNotice(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirmPassword("");
      setPasswordNotice({ ok: true, text: "密码已更新" });
    } catch (error) {
      setPasswordNotice({ ok: false, text: error instanceof Error ? error.message : "修改密码失败" });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-3xl">
        <div className="border-b border-slate-800 pb-5">
          <h2 className="text-xl font-semibold text-slate-100">用户信息</h2>
          <p className="mt-1 text-sm text-slate-500">管理账号资料和登录密码。</p>
        </div>

        <section className="py-6" aria-labelledby="account-profile-heading">
          <h3 id="account-profile-heading" className="mb-4 text-sm font-medium text-slate-200">账号资料</h3>
          <div className="mb-4 flex items-center gap-3 border-b border-slate-800 pb-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-300">
              <UserRound className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-100">{savedName || "未设置显示名称"}</div>
              <div className="truncate text-xs text-slate-500">{user?.email ?? ""}</div>
            </div>
          </div>
          <form onSubmit={(event) => void saveName(event)} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">显示名称</span>
              <input className={inputClass} autoComplete="nickname" maxLength={60} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="输入显示名称" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">登录邮箱</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" aria-hidden="true" />
                <input className={`${inputClass} pl-9`} type="email" value={user?.email ?? ""} readOnly aria-readonly="true" />
              </div>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {nameNotice ? <p role="status" className={`flex items-center gap-1.5 text-xs ${nameNotice.ok ? "text-emerald-400" : "text-rose-400"}`}>
                {nameNotice.ok && <Check className="h-3.5 w-3.5" aria-hidden="true" />}{nameNotice.text}
              </p> : <span />}
              <button type="submit" disabled={savingName || !displayName.trim() || displayName.trim() === savedName} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40">
                {savingName ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存名称
              </button>
            </div>
          </form>
        </section>

        <section className="border-t border-slate-800 py-6" aria-labelledby="account-security-heading">
          <h3 id="account-security-heading" className="mb-4 text-sm font-medium text-slate-200">修改密码</h3>
          <form onSubmit={(event) => void savePassword(event)} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">新密码</span>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" aria-hidden="true" />
                <input className={`${inputClass} pl-9 pr-10`} type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
                <button type="button" onClick={() => setShowPassword((value) => !value)} title={showPassword ? "隐藏密码" : "显示密码"} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-2 top-1 flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:text-slate-200">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">确认新密码</span>
              <input className={inputClass} type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {passwordNotice ? <p role="status" className={`flex items-center gap-1.5 text-xs ${passwordNotice.ok ? "text-emerald-400" : "text-rose-400"}`}>
                {passwordNotice.ok && <Check className="h-3.5 w-3.5" aria-hidden="true" />}{passwordNotice.text}
              </p> : <span />}
              <button type="submit" disabled={savingPassword || !password || !confirmPassword} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-4 text-sm text-slate-200 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40">
                {savingPassword ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                更新密码
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
