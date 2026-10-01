export function SiteFooter({
  className = "px-4 pb-3",
  showDisclaimer = false,
}: {
  className?: string;
  showDisclaimer?: boolean;
}) {
  return (
    <footer
      className={`flex shrink-0 flex-col items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs leading-4 text-slate-400 sm:flex-row ${className}`}
    >
      {showDisclaimer && (
        <>
          <span>AI 回答可能有误，请核实重要信息</span>
          <span aria-hidden="true" className="hidden sm:inline">·</span>
        </>
      )}
      <a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noopener noreferrer"
        className="whitespace-nowrap rounded-sm transition-colors hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
      >
        京ICP备2026054145号
      </a>
    </footer>
  );
}
