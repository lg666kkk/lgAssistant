import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth/use-auth';

export const metadata: Metadata = {
  title: 'Personal Assistant',
  description: 'A Next.js application for building a personal AI assistant',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}
