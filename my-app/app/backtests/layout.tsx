import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Backtests",
  description: "Configurar e executar backtests",
};

export default function BacktestsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
