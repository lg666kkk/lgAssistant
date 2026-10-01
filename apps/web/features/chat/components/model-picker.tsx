"use client";

import { useMemo, useState } from "react";
import { type ChatModelId } from "@/lib/agent/models";
import type { UserLlmModel } from "@/lib/llm/types";

type ModelPickerProps = {
  selectedModel: ChatModelId;
  models: UserLlmModel[];
  loading?: boolean;
  onSelectedModelChange: (model: ChatModelId) => void;
};

export function ModelPicker({
  selectedModel,
  models,
  loading = false,
  onSelectedModelChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedModelOption = models.find((model) => model.id === selectedModel);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;

    return models.filter((model) =>
      `${model.displayName} ${model.modelId} ${model.providerName}`
        .toLowerCase()
        .includes(query),
    );
  }, [models, search]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 max-w-[8.5rem] items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-800/50 px-2.5 text-xs font-medium text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300 sm:max-w-60"
        aria-expanded={open}
      >
        <span className="min-w-0 truncate">
          {loading
            ? "加载模型..."
            : selectedModelOption?.displayName ?? "请配置模型"}
        </span>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="fixed bottom-28 right-3 z-50 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl shadow-black/30 sm:absolute sm:bottom-full sm:left-0 sm:right-auto sm:z-20 sm:mb-2 sm:w-[min(20rem,calc(100vw-3rem))]">
          <div className="flex h-10 items-center gap-2 border-b border-slate-800 px-3">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 shrink-0 text-slate-500"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型"
              aria-label="搜索模型"
              className="min-w-0 flex-1 bg-transparent text-base text-slate-100 outline-none placeholder:text-slate-500 sm:text-xs"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filteredModels.map((model) => {
              const selected = model.id === selectedModel;

              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    onSelectedModelChange(model.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  aria-pressed={selected}
                  title={`${model.displayName} · ${model.providerName} · ${model.modelId}`}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left sm:min-h-9 transition-colors ${
                    selected
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-300 hover:bg-slate-800/70"
                  }`}
                >
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-[18px]">
                      <span className="min-w-0 truncate">{model.displayName}</span>
                      {model.supportsImages && <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 text-[11px] leading-[18px] text-cyan-300">视觉</span>}
                    </span>
                    <span className="max-w-[35%] shrink-0 truncate text-[11px] leading-4 text-slate-400">
                      {model.providerName}
                    </span>
                  </span>
                  {selected && (
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 shrink-0 text-cyan-300"
                    >
                      <path d="m20 6-11 11-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
            {!loading && filteredModels.length === 0 && (
              <div className="px-3 py-3 text-center text-xs leading-5 text-slate-400">
                {models.length > 0 ? "没有匹配的模型" : "请先在连接的大语言模型页面添加 Provider"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
