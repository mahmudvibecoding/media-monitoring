import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Мониторинг СМИ",
  description: "Мониторинг каналов YouTube и Telegram",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
