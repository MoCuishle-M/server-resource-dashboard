import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "算力资源台 · 服务器资源看板",
  description: "公开查看服务器资源与团队排期，申请、审批与使用变更全程留痕。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
