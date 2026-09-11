"use client";

import { useAuth } from "@web/lib/auth/use-auth";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from "react";
import {
  ArrowLeft,
  Box,
  CheckCircle2,
  FileArchive,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";

type Profile = {
  id: "skill-trusted" | "coding-untrusted";
  label: string;
  cpuQuotaMilli: number;
  memoryLimitMb: number;
  pidLimit: number;
  timeoutSeconds: number;
  network: "disabled";
  imageDigest: string;
};

type Manifest = {
  id: string;
  version: string;
  runtime: "node" | "python";
  entrypoint: string[];
  profileId: Profile["id"];
  imageDigest: string;
  bundleSha256: string;
  network: "disabled";
  inputSchema: string;
  outputSchema: string;
};

type ConfiguredSkill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  versions: Manifest[];
};

type SkillDraft = Pick<ConfiguredSkill, "id" | "name" | "description" | "enabled">;

type VersionDraft = {
  version: string;
  runtime: "node" | "python";
  entrypoint: string;
  profileId: Profile["id"];
  imageDigest: string;
  inputSchema: string;
  outputSchema: string;
  bundle: File | null;
};

type RunState = {
  runId: string;
  status: string;
  profileId: string;
  skillVersion?: string;
  message?: string;
};

const emptySkill = (): SkillDraft => ({ id: "", name: "", description: "", enabled: false });

const emptyVersion = (): VersionDraft => ({
  version: "1.0.0",
  runtime: "node",
  entrypoint: "node scripts/run.mjs",
  profileId: "skill-trusted",
  imageDigest: "",
  inputSchema: "schemas/input.json",
  outputSchema: "schemas/output.json",
  bundle: null,
});

const terminalStatuses = new Set(["completed", "failed", "timed_out", "cancelled", "dead", "unavailable"]);

export function SkillCenter() {
  const { user } = useAuth();
  const [skills, setSkills] = useState<ConfiguredSkill[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(emptySkill());
  const [versionDraft, setVersionDraft] = useState<VersionDraft>(emptyVersion());
  const [selectedVersion, setSelectedVersion] = useState("");
  const [runInput, setRunInput] = useState("{}");
  const [run, setRun] = useState<RunState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "publish" | "run" | "refresh" | "toggle" | "delete" | "import" | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedId) ?? null,
    [selectedId, skills],
  );
  const selectedProfile = profiles.find((profile) => profile.id === versionDraft.profileId);

  const load = async (preferredId?: string | null) => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/skills", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "加载 Skill 失败");
      const nextSkills = (data.skills ?? []) as ConfiguredSkill[];
      setSkills(nextSkills);
      const nextProfiles = (data.profiles ?? []) as Profile[];
      setProfiles(nextProfiles);
      setVersionDraft((current) => current.imageDigest
        ? current
        : { ...current, imageDigest: nextProfiles.find((profile) => profile.id === current.profileId)?.imageDigest ?? "" });
      setCanEdit(Boolean(data.canEdit));
      const nextId = preferredId !== undefined
        ? preferredId && nextSkills.some((item) => item.id === preferredId) ? preferredId : null
        : selectedId && nextSkills.some((item) => item.id === selectedId) ? selectedId : null;
      setSelectedId(nextId);
      const nextSkill = nextSkills.find((item) => item.id === nextId);
      if (nextSkill) setSkillDraft(toDraft(nextSkill));
      setSelectedVersion(nextSkill?.versions[0]?.version ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载 Skill 失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const syncViewFromURL = () => {
      const skillId = new URLSearchParams(window.location.search).get("skillId");
      if (skillId === "new") {
        setCreating(true);
        setSelectedId(null);
        setSkillDraft(emptySkill());
        void load(null);
        return;
      }
      setCreating(false);
      void load(skillId);
    };
    syncViewFromURL();
    window.addEventListener("popstate", syncViewFromURL);
    return () => window.removeEventListener("popstate", syncViewFromURL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    const timer = window.setInterval(() => void refreshRun(), 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.runId, run?.status]);

  const selectSkill = (skill: ConfiguredSkill) => {
    setCreating(false);
    setSelectedId(skill.id);
    setSkillDraft(toDraft(skill));
    setSelectedVersion(skill.versions[0]?.version ?? "");
    setVersionDraft({
      ...emptyVersion(),
      imageDigest: profiles.find((profile) => profile.id === "skill-trusted")?.imageDigest ?? "",
    });
    setRun(null);
    setError(null);
    setNotice(null);
    updateSkillURL(skill.id);
  };

  const openList = () => {
    setCreating(false);
    setSelectedId(null);
    setRun(null);
    setError(null);
    setNotice(null);
    updateSkillURL(null);
  };

  const openCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setSkillDraft(emptySkill());
    setRun(null);
    setError(null);
    setNotice(null);
    updateSkillURL("new");
  };

  const saveSkill = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skillDraft),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存 Skill 失败");
      await load(skillDraft.id.trim());
      setCreating(false);
      updateSkillURL(skillDraft.id.trim());
      setNotice("Skill 已保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存 Skill 失败");
    } finally {
      setBusy(null);
    }
  };

  const toggleSkill = async (skill: ConfiguredSkill, enabled: boolean) => {
    setBusy("toggle");
    setError(null);
    try {
      const response = await authFetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "更新 Skill 状态失败");
      await load(null);
      setNotice(enabled ? "Skill 已启用" : "Skill 已停用");
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "更新 Skill 状态失败");
    } finally {
      setBusy(null);
    }
  };

  const importSkill = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setBusy("import");
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const response = await authFetch("/api/skills", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "导入 Skill 失败");
      await load(data.skill.id);
      setNotice(`已导入 Skill：${data.skill.name}`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "导入 Skill 失败");
    } finally {
      setBusy(null);
    }
  };

  const deleteSkill = async (skill: ConfiguredSkill) => {
    if (!window.confirm(`删除 Skill“${skill.name}”？历史版本和 Run 将保留用于审计。`)) return;
    setBusy("delete");
    setError(null);
    try {
      const response = await authFetch(`/api/skills?id=${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "删除 Skill 失败");
      }
      await load(null);
      updateSkillURL(null);
      setNotice("Skill 已删除");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除 Skill 失败");
    } finally {
      setBusy(null);
    }
  };

  const publishVersion = async () => {
    if (!selectedSkill || !versionDraft.bundle) return;
    if (versionDraft.bundle.size > 10 * 1024 * 1024) {
      setError("Skill Bundle 不能超过 10MiB");
      return;
    }
    setBusy("publish");
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/skills/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId: selectedSkill.id,
          version: versionDraft.version,
          runtime: versionDraft.runtime,
          entrypoint: splitCommand(versionDraft.entrypoint),
          profileId: versionDraft.profileId,
          imageDigest: versionDraft.imageDigest,
          inputSchema: versionDraft.inputSchema,
          outputSchema: versionDraft.outputSchema,
          bundleBase64: await fileToBase64(versionDraft.bundle),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "发布 Skill 版本失败");
      await load(selectedSkill.id);
      setSelectedVersion(versionDraft.version);
      const defaultProfile = profiles.find((profile) => profile.id === "skill-trusted");
      setVersionDraft({ ...emptyVersion(), imageDigest: defaultProfile?.imageDigest ?? "" });
      setNotice(`版本 ${versionDraft.version} 已发布`);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "发布 Skill 版本失败");
    } finally {
      setBusy(null);
    }
  };

  const startRun = async () => {
    if (!selectedSkill || !selectedVersion) return;
    setBusy("run");
    setError(null);
    setNotice(null);
    try {
      const input = JSON.parse(runInput);
      const response = await authFetch("/api/skills/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selectedSkill.id, skillVersion: selectedVersion, input }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "启动 Skill 失败");
      setRun(data.run);
      setNotice("Skill Run 已创建");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "启动 Skill 失败");
    } finally {
      setBusy(null);
    }
  };

  const refreshRun = async () => {
    if (!run) return;
    setBusy("refresh");
    try {
      const response = await authFetch(`/api/skills/runs/${encodeURIComponent(run.runId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "刷新 Run 失败");
      setRun(data.run);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "刷新 Run 失败");
    } finally {
      setBusy(null);
    }
  };

  const cancelRun = async () => {
    if (!run || terminalStatuses.has(run.status)) return;
    setBusy("refresh");
    setError(null);
    try {
      const response = await authFetch(`/api/skills/runs/${encodeURIComponent(run.runId)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "取消 Run 失败");
      }
      await refreshRun();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "取消 Run 失败");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-500"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载 Skill...</div>;
  }

  if (!selectedSkill && !creating) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Skill 列表</h2>
              <p className="mt-1 text-sm text-slate-500">{user ? `${skills.length} 个 Skill` : "登录后查看 Skill"}</p>
            </div>
            <button type="button" onClick={() => importInput.current?.click()} disabled={busy !== null} className="flex h-9 items-center gap-2 rounded-md bg-cyan-600 px-3 text-sm text-white hover:bg-cyan-500 disabled:opacity-50">
              <Upload className="h-4 w-4" />上传 Skill
            </button>
            <input ref={importInput} type="file" multiple className="sr-only" onChange={(event) => void importSkill(event)} {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} />
          </div>

          {skills.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {skills.map((skill) => (
                <article key={skill.id} className="flex min-h-44 flex-col rounded-md border border-slate-800 bg-slate-900/70 transition-colors hover:border-slate-700">
                  <button type="button" onClick={() => selectSkill(skill)} className="min-w-0 flex-1 px-4 py-4 text-left">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-300"><Box className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-100">{skill.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-slate-600">{skill.id}</span>
                      </span>
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${skill.enabled ? "bg-emerald-400" : "bg-slate-600"}`} title={skill.enabled ? "已启用" : "已停用"} />
                    </div>
                    <span className="mt-4 line-clamp-2 block min-h-10 text-sm leading-5 text-slate-400">{skill.description || "暂无描述"}</span>
                  </button>
                  <div className="flex h-11 items-center gap-3 border-t border-slate-800 px-4">
                    <span className="text-xs text-slate-500">{skill.versions.length} 个版本</span>
                    {canEdit && (
                      <>
                        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                          <input type="checkbox" checked={skill.enabled} disabled={busy !== null} onChange={(event) => void toggleSkill(skill, event.target.checked)} className="h-4 w-4 accent-cyan-500" />
                          {skill.enabled ? "启用" : "停用"}
                        </label>
                        <button type="button" disabled={busy !== null} onClick={() => void deleteSkill(skill)} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50" title="删除 Skill" aria-label={`删除 ${skill.name}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center border border-dashed border-slate-800 text-center">
              <Box className="mb-3 h-6 w-6 text-slate-600" />
              <p className="text-sm text-slate-400">{user ? "暂无 Skill" : "登录后查看和管理 Skill"}</p>
            </div>
          )}
        </div>
        <Feedback error={error} notice={notice} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950">
      <div className="mx-auto max-w-6xl">
        <div className="flex h-14 items-center gap-3 border-b border-slate-800 px-4 sm:px-6">
          <button type="button" onClick={openList} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white" title="返回 Skill 列表" aria-label="返回 Skill 列表"><ArrowLeft className="h-4 w-4" /></button>
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold text-slate-100">{creating ? "新建 Skill" : selectedSkill?.name}</h2>{selectedSkill && <p className="truncate font-mono text-xs text-slate-600">{selectedSkill.id}</p>}</div>
        </div>
        <section className="border-b border-slate-800 px-6 py-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">基本配置</h2>
            {canEdit && (
              <button type="button" disabled={busy !== null || !skillDraft.id.trim() || !skillDraft.name.trim()} onClick={() => void saveSkill()} className="flex h-9 items-center gap-2 rounded-md bg-cyan-600 px-3 text-sm text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50">
                {busy === "save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存
              </button>
            )}
          </div>
          <div className="grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Skill ID"><input disabled={!canEdit || Boolean(selectedSkill)} value={skillDraft.id} onChange={(event) => setSkillDraft({ ...skillDraft, id: event.target.value })} className={inputClass} placeholder="markdown-check" /></Field>
            <Field label="名称"><input disabled={!canEdit} value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} className={inputClass} /></Field>
            <Field label="描述" wide><textarea disabled={!canEdit} value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} className={`${inputClass} min-h-20 resize-y py-2`} /></Field>
            <label className="flex items-center gap-3 text-sm text-slate-300"><input type="checkbox" disabled={!canEdit} checked={skillDraft.enabled} onChange={(event) => setSkillDraft({ ...skillDraft, enabled: event.target.checked })} className="h-4 w-4 accent-cyan-500" />启用</label>
          </div>
        </section>

        {selectedSkill && (
          <>
            <section className="border-b border-slate-800 px-6 py-5">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-100">已发布版本</h2><span className="text-xs text-slate-500">{selectedSkill.versions.length} 个版本</span></div>
              <div className="overflow-x-auto rounded-md border border-slate-800">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="bg-slate-900 text-slate-500"><tr><th className="px-3 py-2.5">版本</th><th className="px-3 py-2.5">运行时</th><th className="px-3 py-2.5">入口</th><th className="px-3 py-2.5">Sandbox</th><th className="px-3 py-2.5">Bundle SHA-256</th></tr></thead>
                  <tbody className="divide-y divide-slate-800">{selectedSkill.versions.map((version) => <tr key={version.version} className="text-slate-300"><td className="px-3 py-3 font-mono">{version.version}</td><td className="px-3 py-3">{version.runtime}</td><td className="px-3 py-3 font-mono">{version.entrypoint.join(" ")}</td><td className="px-3 py-3"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />{version.profileId}</span></td><td className="max-w-48 truncate px-3 py-3 font-mono text-slate-500" title={version.bundleSha256}>{version.bundleSha256}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            {canEdit && (
              <section className="border-b border-slate-800 px-6 py-5">
                <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-100">发布版本</h2><button type="button" disabled={busy !== null || !versionDraft.bundle} onClick={() => void publishVersion()} className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50">{busy === "publish" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}发布</button></div>
                <div className="grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <Field label="版本"><input value={versionDraft.version} onChange={(event) => setVersionDraft({ ...versionDraft, version: event.target.value })} className={inputClass} /></Field>
                  <Field label="运行时"><select value={versionDraft.runtime} onChange={(event) => { const runtime = event.target.value as VersionDraft["runtime"]; setVersionDraft({ ...versionDraft, runtime, entrypoint: runtime === "node" ? "node scripts/run.mjs" : "python3 scripts/run.py" }); }} className={inputClass}><option value="node">Node.js</option><option value="python">Python</option></select></Field>
                  <Field label="入口"><input value={versionDraft.entrypoint} onChange={(event) => setVersionDraft({ ...versionDraft, entrypoint: event.target.value })} className={inputClass} /></Field>
                  <Field label="Sandbox Profile"><select value={versionDraft.profileId} onChange={(event) => { const profileId = event.target.value as Profile["id"]; const profile = profiles.find((item) => item.id === profileId); setVersionDraft({ ...versionDraft, profileId, imageDigest: profile?.imageDigest ?? "" }); }} className={inputClass}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></Field>
                  <Field label="输入 Schema"><input value={versionDraft.inputSchema} onChange={(event) => setVersionDraft({ ...versionDraft, inputSchema: event.target.value })} className={inputClass} /></Field>
                  <Field label="输出 Schema"><input value={versionDraft.outputSchema} onChange={(event) => setVersionDraft({ ...versionDraft, outputSchema: event.target.value })} className={inputClass} /></Field>
                  <Field label="镜像 Digest" wide><input value={versionDraft.imageDigest} onChange={(event) => setVersionDraft({ ...versionDraft, imageDigest: event.target.value })} className={`${inputClass} font-mono`} placeholder="registry/image@sha256:..." /></Field>
                  <Field label="Bundle" wide><label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-700 px-3 text-sm text-slate-400 hover:border-slate-600 hover:text-slate-200"><FileArchive className="h-4 w-4" /><span className="truncate">{versionDraft.bundle?.name ?? "选择 .tar 文件"}</span><input type="file" accept=".tar,application/x-tar" className="sr-only" onChange={(event) => setVersionDraft({ ...versionDraft, bundle: event.target.files?.[0] ?? null })} /></label></Field>
                </div>
                {selectedProfile && <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500"><span>CPU {selectedProfile.cpuQuotaMilli}m</span><span>内存 {selectedProfile.memoryLimitMb}MiB</span><span>PID {selectedProfile.pidLimit}</span><span>超时 {selectedProfile.timeoutSeconds}s</span><span>网络关闭</span></div>}
              </section>
            )}

            <section className="px-6 py-5">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-100">运行测试</h2><button type="button" disabled={busy !== null || !selectedVersion || !selectedSkill.enabled} onClick={() => void startRun()} className="flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-3 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">{busy === "run" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}运行</button></div>
              <div className="grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                <Field label="版本"><select value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} className={inputClass}><option value="">选择版本</option>{selectedSkill.versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select></Field>
                <Field label="输入 JSON"><textarea value={runInput} onChange={(event) => setRunInput(event.target.value)} className={`${inputClass} min-h-28 resize-y py-2 font-mono`} spellCheck={false} /></Field>
              </div>
              {run && <div className="mt-4 flex max-w-5xl flex-wrap items-center gap-3 rounded-md border border-slate-800 bg-slate-900 px-4 py-3 text-sm"><RunStatusIcon status={run.status} /><span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400">{run.runId}</span><span className="text-slate-300">{run.status}</span>{!terminalStatuses.has(run.status) && <button type="button" onClick={() => void cancelRun()} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-rose-300" title="取消运行" aria-label="取消运行"><Square className="h-4 w-4" /></button>}<button type="button" onClick={() => void refreshRun()} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white" title="刷新状态" aria-label="刷新状态"><RefreshCw className={`h-4 w-4 ${busy === "refresh" ? "animate-spin" : ""}`} /></button></div>}
            </section>
          </>
        )}

        <Feedback error={error} notice={notice} />
      </div>
    </div>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={`block ${wide ? "md:col-span-2 lg:col-span-3" : ""}`}><span className="mb-1.5 block text-xs font-medium text-slate-500">{label}</span>{children}</label>;
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (terminalStatuses.has(status)) return <XCircle className="h-4 w-4 text-rose-400" />;
  return <LoaderCircle className="h-4 w-4 animate-spin text-cyan-400" />;
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (!error && !notice) return null;
  return <div className={`fixed bottom-5 right-5 z-50 max-w-[calc(100vw-2rem)] rounded-md border px-4 py-3 text-sm shadow-xl ${error ? "border-rose-800 bg-rose-950 text-rose-200" : "border-emerald-800 bg-emerald-950 text-emerald-200"}`}>{error ?? notice}</div>;
}

function toDraft(skill: ConfiguredSkill): SkillDraft {
  return { id: skill.id, name: skill.name, description: skill.description, enabled: skill.enabled };
}

function splitCommand(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("读取 Bundle 失败"));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取 Bundle 失败"));
    reader.readAsDataURL(file);
  });
}

function updateSkillURL(skillId: string | null) {
  const url = new URL(window.location.href);
  if (skillId) url.searchParams.set("skillId", skillId);
  else url.searchParams.delete("skillId");
  window.history.pushState({}, "", url);
}

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-600 disabled:cursor-not-allowed disabled:opacity-60";
