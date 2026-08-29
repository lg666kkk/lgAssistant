import type { Metadata } from 'next';
import './globals.css';
import { SiteFooter } from '@web/layout/site-footer';
import { AuthProvider } from '@web/lib/auth/use-auth';

export const metadata: Metadata = {
  title: '知识助手',
  description: '用你的知识丰富你的生活',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          <div className="grid h-[100dvh] grid-rows-[minmax(0,1fr)_auto] bg-slate-950">
            <div className="min-h-0 overflow-hidden">{children}</div>
            <SiteFooter />
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
