import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chart — OHLCV",
  description: "Velas a partir da QuestDB",
};

export default function ChartLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
