"use client";
import { useId, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, MessageCircleQuestion } from "lucide-react";
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
  if (submitted) return <div className="mt-3 max-w-2xl rounded-xl border border-slate-700/60 bg-slate-900/40 p-4"><p className="flex items-center gap-1.5 text-xs text-emerald-300"><Check aria-hidden="true" className="h-3.5 w-3.5" />已回答</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">{submitted}</p></div>;
  const update = (value: string) => setAnswers(current => ({ ...current, [page]: value }));
  const ready = questions.every((_, index) => answers[index]?.trim());
  const multiple = questions.length > 1;
  const answeredCount = questions.filter((_, index) => answers[index]?.trim()).length;
  const questionId = `${cardId}-question-${page}`;
  const locked = disabled || busy;
  return <section aria-label="助手提问" className="mt-3 w-full max-w-2xl overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/50">
    <header className="flex min-h-12 items-center justify-between gap-3 px-4 py-2">
      <span className="flex items-center gap-2 text-xs font-medium text-slate-300"><MessageCircleQuestion aria-hidden="true" className="h-4 w-4 text-cyan-400" />补充信息</span>
      {multiple && <nav aria-label="问题切换" className="flex items-center gap-1 text-slate-400">
        <button type="button" aria-label="上一题" disabled={page === 0 || locked} onClick={() => setPage(page - 1)} className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>
        <span aria-live="polite" aria-atomic="true" className="min-w-10 text-center text-xs tabular-nums">{page + 1} / {questions.length}</span>
        <button type="button" aria-label="下一题" disabled={page === questions.length - 1 || locked} onClick={() => setPage(page + 1)} className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
      </nav>}
    </header>
    <fieldset disabled={locked} className="min-w-0 px-4 pb-3"><legend id={questionId} className="mb-3 w-full break-words text-sm font-medium leading-relaxed text-slate-100">{question.question}</legend>
      {!!question.choices?.length && <div className="space-y-2">{question.choices.map((choice, index) => <label key={index} className={`flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-cyan-400 ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${!custom[page] && answers[page] === choice ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-100" : "border-slate-700/60 text-slate-300 hover:bg-slate-800/70"}`}><input type="radio" name={questionId} checked={!custom[page] && answers[page] === choice} onChange={() => { setCustom(current => ({ ...current, [page]: false })); update(choice); }} className="mt-1 accent-cyan-500" /><span className="text-slate-400">{String.fromCharCode(65 + index)}</span><span className="min-w-0 break-words">{choice}</span></label>)}</div>}
      {!!question.choices?.length && <label className={`mt-2 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-slate-300 focus-within:ring-2 focus-within:ring-cyan-400 ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}><input type="radio" name={questionId} checked={Boolean(custom[page])} onChange={() => { setCustom(current => ({ ...current, [page]: true })); update(""); }} className="accent-cyan-500" />其他，自定义回答</label>}
      {(!question.choices?.length || custom[page]) && <textarea aria-label="自定义回答" aria-describedby={questionId} value={answers[page] ?? ""} maxLength={2000} onChange={event => update(event.target.value)} placeholder="输入你的回答…" rows={2} className="block min-h-20 w-full resize-y rounded-lg border border-slate-600 bg-slate-950/50 px-3 py-2.5 text-base leading-relaxed text-slate-100 placeholder:text-slate-400 transition-colors focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm" />}
    </fieldset>
    {error && <p role="alert" className="px-4 pb-3 text-xs text-rose-300">{error}</p>}
    <footer className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-0.5"><span className="text-[11px] leading-4 text-slate-400">{multiple ? `已回答 ${answeredCount} / ${questions.length}` : "回答后继续"}</span><button type="button" disabled={locked || (!ready && !answers[page]?.trim())} className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md bg-cyan-400 px-3 py-1.5 text-xs font-normal text-slate-950 transition-colors hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400" onClick={async () => {
      if (!ready) { setPage(questions.findIndex((_, index) => !answers[index]?.trim())); return; }
      setBusy(true); setError("");
      try { await onSubmit(formatUserAnswers(questions, questions.map((_, index) => answers[index]))); }
      catch (e) { setError(e instanceof Error ? e.message : "提交失败，请重试"); }
      finally { setBusy(false); }
    }}>{busy ? <><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />提交中…</> : <>{!multiple || ready ? "提交并继续" : "下一题"}<ArrowRight aria-hidden="true" className="h-3 w-3" /></>}</button></footer>
  </section>;
}
