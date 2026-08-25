"use client";

import { usePathname } from "next/navigation";

export function SiteFooter() {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  return (
    <footer
      className={`px-4 py-2 text-center text-xs ${
        isLoginPage
          ? "bg-[#090b0f] text-zinc-600"
          : "bg-slate-950 text-slate-500"
      }`}
    >
      <a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noopener noreferrer"
        className={`transition-colors ${
          isLoginPage ? "hover:text-zinc-300" : "hover:text-slate-300"
        }`}
      >
        京ICP备2026054145号
      </a>
    </footer>
  );
}
