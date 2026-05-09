import type { Metadata } from 'next';
import './globals.css';

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
      <body>{children}</body>
    </html>
  );
}
