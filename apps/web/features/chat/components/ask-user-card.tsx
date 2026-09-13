"use client";
import { useId, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircleQuestion } from "lucide-react";
export type UserQuestion = { question: string; choices?: string[]; mode?: string };
export function readUserQuestions(metadata?: Record<string, unknown>): UserQuestion[] {
  const values = Array.isArray(metadata?.questions) ? metadata.questions : [metadata];
  return values.flatMap(value => {
    if (!value || typeof value !== "object" || typeof value.question !== "string") return [];
    return [{ question: value.question, choices: Array.isArray(value.choices) ? value.choices.filter((item: unknown): item is string => typeof item === "string").slice(0, 6) : [] }];
  }).slice(0, 3);
}
export function formatUserAnswers(questions: UserQuestion[], answers: string[]) {
  return questions.map((item, index) => `${index + 1}. ${item.question}\n回答：${answers[index]?.trim() ?? ""}`).join("\n\n");
}
export function AskUserCard({ questions, disabled, submitted, onSubmit }: {
  questions: UserQuestion[]; disabled?: boolean; submitted?: string; onSubmit: (answer: string) => Promise<void>;
}) {
  const cardId = useId();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const question = questions[page];
  if (!question) return null;
  if (submitted) return <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4"><p className="text-xs text-emerald-300">已回答</p><p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{submitted}</p></div>;
  const update = (value: string) => setAnswers(current => ({ ...current, [page]: value }));
  const ready = questions.every((_, index) => answers[index]?.trim());
  return <section aria-label="助手提问" className="mt-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/60">
    <header className="flex items-center justify-between px-4 py-3 text-slate-400"><span className="flex items-center gap-2 text-sm"><MessageCircleQuestion className="h-4 w-4 text-amber-300" />需要你补充</span><div className="flex items-center gap-2"><button type="button" aria-label="上一题" disabled={page === 0 || busy} onClick={() => setPage(page - 1)} className="disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button><span className="text-xs">{page + 1} / {questions.length}</span><button type="button" aria-label="下一题" disabled={page === questions.length - 1 || busy} onClick={() => setPage(page + 1)} className="disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button></div></header>
    <fieldset disabled={disabled || busy} className="px-4 pb-4"><legend className="mb-3 text-sm font-medium text-slate-100">{page + 1}. {question.question}</legend>
      <div className="space-y-2">{question.choices?.map((choice, index) => <label key={index} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${!custom[page] && answers[page] === choice ? "border-cyan-500 bg-cyan-500/10 text-cyan-100" : "border-slate-700/60 text-slate-300 hover:bg-slate-800"}`}><input type="radio" name={`${cardId}-question-${page}`} checked={!custom[page] && answers[page] === choice} onChange={() => { setCustom(current => ({ ...current, [page]: false })); update(choice); }} className="mt-1 accent-cyan-500" /><span className="text-slate-500">{String.fromCharCode(65 + index)}</span><span>{choice}</span></label>)}</div>
      {!!question.choices?.length && <label className="mt-3 flex cursor-pointer items-center gap-3 text-sm text-slate-400"><input type="radio" name={`${cardId}-question-${page}`} checked={Boolean(custom[page])} onChange={() => { setCustom(current => ({ ...current, [page]: true })); update(""); }} className="accent-cyan-500" />其他，自定义回答</label>}
      {(!question.choices?.length || custom[page]) && <textarea aria-label="自定义回答" value={answers[page] ?? ""} maxLength={2000} onChange={event => update(event.target.value)} placeholder="输入你的回答…" rows={3} className="mt-3 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />}
    </fieldset>
    {error && <p role="alert" className="px-4 pb-3 text-xs text-rose-300">{error}</p>}
    <footer className="flex items-center justify-between border-t border-slate-700 px-4 py-3"><span className="text-xs text-slate-500">已回答 {questions.filter((_, index) => answers[index]?.trim()).length} / {questions.length}</span><button type="button" disabled={disabled || busy || (!ready && !answers[page]?.trim())} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-40" onClick={async () => {
      if (!ready) { setPage(questions.findIndex((_, index) => !answers[index]?.trim())); return; }
      setBusy(true); setError("");
      try { await onSubmit(formatUserAnswers(questions, questions.map((_, index) => answers[index]))); }
      catch (e) { setError(e instanceof Error ? e.message : "提交失败，请重试"); }
      finally { setBusy(false); }
    }}>{busy ? "提交中…" : ready ? "提交并继续" : "下一题"}</button></footer>
  </section>;
}
