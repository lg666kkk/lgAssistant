"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal, Trash2 } from "lucide-react";
import type { UserLlmModelDraft } from "@/lib/llm/types";

import { detectThinkingProtocol, readThinkingSelection, supportsThinkingOff, writeThinkingSelection, type ThinkingMode, type ThinkingProtocol } from "@/lib/llm/reasoning";

type Props = {
  baseUrl?: string;
  model: UserLlmModelDraft;
  expanded: boolean;
  canRemove: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<UserLlmModelDraft>) => void;
  onRemove: () => void;
};

const inputClass = "h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500 disabled:cursor-not-allowed disabled:text-slate-500";
const protocolLabels = { auto: "自动识别（推荐）", deepseek: "DeepSeek thinking", qwen: "千问 enable_thinking", thinking: "Kimi / GLM thinking" };

function Field({ label, hint, children }: {
  label: string;
  hint: string;
  children: (descriptionId: string) => ReactNode;
}) {
  const id = useId();
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
      {children(id)}
      <span id={id} className="mt-1.5 block text-xs leading-relaxed text-slate-400">{hint}</span>
    </label>
  );
}

function capacity(value: number) {
  return value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
}

export function ModelConfigurationRow({ model, baseUrl = "", expanded, canRemove, onToggle, onChange, onRemove }: Props) {
  const panelId = useId();
  const thinking = readThinkingSelection(model.reasoningMode);
  const detected = detectThinkingProtocol(baseUrl, model.modelId);
  const canDisableThinking = supportsThinkingOff(model.modelId);
  const thinkingHint = thinking.mode === "default"
    ? "不发送思考开关，跟随接口默认行为。"
    : thinking.protocol !== "auto"
      ? "使用手动指定的协议，请确认 Provider 支持。"
      : detected
        ? `自动适配：${protocolLabels[detected]}。第三方网关可能有差异，可在高级设置覆盖。`
        : "未识别到可靠的思考协议，将跟随接口默认；如需强制切换，请在高级设置指定协议。";
  const name = model.displayName.trim() || model.modelId.trim() || "新模型";
  return (
    <div className={expanded ? "bg-slate-900/40" : ""}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0 flex-1 basis-44">
          <p className="break-words text-sm font-medium text-slate-100">{name}</p>
          {model.modelId && model.modelId !== name && (
            <p className="mt-1 break-all font-mono text-xs text-slate-400">{model.modelId}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {model.supportsTools && <span className="rounded border border-cyan-900/60 bg-cyan-950/30 px-1.5 py-0.5 text-cyan-300">工具调用</span>}
            {model.supportsImages && <span className="rounded border border-cyan-900/60 bg-cyan-950/30 px-1.5 py-0.5 text-cyan-300">图片输入</span>}
            {model.reasoningMode !== "none" && <span className="rounded border border-slate-700 px-1.5 py-0.5">{thinking.mode === "on" ? "思考：开启" : "思考：关闭"}</span>}
            <span>上下文 {capacity(model.contextWindow)} · 输出 {capacity(model.maxOutputTokens)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-xs text-slate-300">
            <input type="checkbox" checked={model.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} aria-label={`启用 ${name}`} className="h-4 w-4 accent-cyan-500" />
            {model.enabled ? "已启用" : "已停用"}
          </label>
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId} aria-label={`${expanded ? "收起" : "编辑"} ${name}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500">
            {expanded ? "收起" : "编辑"}<ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
          <button type="button" disabled={!canRemove} onClick={onRemove} aria-label={`删除 ${name}`} title={canRemove ? "删除模型" : "至少保留一个模型"} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-rose-950/40 hover:text-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500 disabled:opacity-30">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div id={panelId} hidden={!expanded} className="border-t border-slate-800 px-3 pb-4 pt-4 sm:px-4">
        {expanded && <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="模型 ID" hint="Provider 接口使用的准确标识，请勿随意修改。">
              {(id) => <input className={inputClass} value={model.modelId} aria-describedby={id} onChange={(event) => onChange({ modelId: event.target.value, displayName: !model.displayName || model.displayName === model.modelId ? event.target.value : model.displayName })} placeholder="例如 deepseek-chat" />}
            </Field>
            <Field label="显示名称" hint="仅用于界面展示的别名，不影响接口请求。">
              {(id) => <input className={inputClass} value={model.displayName} aria-describedby={id} onChange={(event) => onChange({ displayName: event.target.value })} placeholder={model.modelId || "默认使用模型 ID"} />}
            </Field>
            <Field label="上下文窗口（Token）" hint="单次请求的输入与输出总容量，用于上下文估算与裁剪。">
              {(id) => <input type="number" min="4096" max="2000000" step="1" className={inputClass} value={model.contextWindow} aria-describedby={id} onChange={(event) => onChange({ contextWindow: Number(event.target.value) })} />}
            </Field>
            <Field label="最大输出（Token）" hint="每次回答的输出上限，也用于预留上下文空间。">
              {(id) => <input type="number" min="64" max="131072" step="1" className={inputClass} value={model.maxOutputTokens} aria-describedby={id} onChange={(event) => onChange({ maxOutputTokens: Number(event.target.value) })} />}
            </Field>
          </div>
          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-slate-300">允许的能力</legend>
            <div className="mt-1 flex flex-wrap gap-x-6">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={model.supportsTools} onChange={(event) => onChange({ supportsTools: event.target.checked })} className="h-4 w-4 accent-cyan-500" />工具调用</label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={model.supportsImages} onChange={(event) => onChange({ supportsImages: event.target.checked })} className="h-4 w-4 accent-cyan-500" />图片输入</label>
            </div>
            <p className="text-xs leading-relaxed text-slate-400">开启后才会向模型发送工具或图片；不会让模型获得原本不支持的能力。容量与能力请按 Provider 文档核实，获取列表只导入模型 ID。</p>
          </fieldset>
          <div className="mt-4 max-w-xl">
            <Field label="思考模式" hint={!canDisableThinking ? `${thinkingHint} 此模型不支持关闭思考。` : thinkingHint}>
              {(id) => <select className={inputClass} value={thinking.mode} aria-describedby={id} onChange={(event) => onChange({ reasoningMode: writeThinkingSelection(event.target.value as ThinkingMode, thinking.protocol) })}>
                <option value="default">默认（跟随接口）</option>
                <option value="on">开启</option>
                <option value="off" disabled={!canDisableThinking}>关闭{!canDisableThinking ? "（不支持）" : ""}</option>
              </select>}
            </Field>
          </div>
          <details className="group mt-4 border-t border-slate-800 pt-2">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-medium text-slate-300 hover:text-cyan-300">
              <SlidersHorizontal className="h-4 w-4" />高级设置<span className="font-normal text-slate-400">协议覆盖、费用</span><ChevronDown className="ml-auto h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 max-w-xl">
              <Field label="思考协议" hint="通常保持自动识别。第三方网关或自部署接口可手动指定；默认模式无需指定协议。">
                {(id) => <select className={inputClass} value={thinking.protocol} disabled={thinking.mode === "default"} aria-describedby={id} onChange={(event) => onChange({ reasoningMode: writeThinkingSelection(thinking.mode, event.target.value as ThinkingProtocol) })}>
                  {Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>}
              </Field>
            </div>
            <fieldset className="mt-4 border-t border-slate-800 pt-4">
              <legend className="text-xs font-medium text-slate-300">费用估算（可选）</legend>
              <p className="mb-3 text-xs leading-relaxed text-slate-400">单位：人民币 / 百万 Token。留空不估算相应费用，不影响使用；这里不是实际账单。</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {([ ["inputCacheHit", "缓存命中输入"], ["inputCacheMiss", "缓存未命中输入"], ["output", "输出"] ] as const).map(([key, label]) => (
                  <label key={key} className="block min-w-0">
                    <span className="mb-1.5 block text-xs text-slate-300">{label}</span>
                    <input type="number" min="0" step="0.000001" className={inputClass} value={model.pricing[key] ?? ""} onChange={(event) => onChange({ pricing: { ...model.pricing, [key]: event.target.value === "" ? null : Number(event.target.value) } })} placeholder="未配置" />
                  </label>
                ))}
              </div>
            </fieldset>
          </details>
          <p className="mt-4 text-xs text-slate-400">修改后点击下方「保存 Provider」统一保存。</p>
        </>}
      </div>
    </div>
  );
}
