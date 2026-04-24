"use client";

import type { ReactNode } from "react";

import { BacktestJobProvider } from "@/components/BacktestJobProvider";

export function AppProviders({ children }: { children: ReactNode }) {
  return <BacktestJobProvider>{children}</BacktestJobProvider>;
}
