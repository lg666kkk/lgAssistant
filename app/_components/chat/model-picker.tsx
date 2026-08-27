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
        className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-700 bg-slate-800/70 px-3.5 text-sm font-medium text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        aria-expanded={open}
      >
        {loading
          ? "加载模型..."
          : selectedModelOption?.displayName ?? "请配置模型"}
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
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-3 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50">
          <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-3">
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
              className="text-slate-500"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all models"
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            <div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              已启用模型
            </div>
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
                  className={`flex w-full items-start justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                    selected
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-300 hover:bg-slate-800/70"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      {model.displayName}
                      {model.supportsImages && <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 text-xs text-cyan-300">视觉</span>}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      {model.providerName} · {model.modelId}
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
                      className="mt-0.5 shrink-0 text-cyan-300"
                    >
                      <path d="m20 6-11 11-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
            {!loading && filteredModels.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-slate-500">
                请先在连接的大语言模型页面添加 Provider
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
