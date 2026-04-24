"use client";

import { createContext, useContext, type Dispatch, type ReactNode, type SetStateAction } from "react";

export const SetChartHeaderSlotContext = createContext<
  Dispatch<SetStateAction<ReactNode>> | null
>(null);

export function useSetChartHeaderSlot() {
  const set = useContext(SetChartHeaderSlotContext);
  if (!set) {
    throw new Error("useSetChartHeaderSlot must be used within AppShell");
  }
  return set;
}
