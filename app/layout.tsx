import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@web/components/ui/toast';
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
          <ToastProvider>
            <div className="h-[100dvh] overflow-hidden bg-slate-950">
              {children}
            </div>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
