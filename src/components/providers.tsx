"use client";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      {children}
      <Toaster
        theme="system"
        position="top-right"
        richColors
        closeButton
        toastOptions={{
          classNames: {
            toast:
              "border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)]",
          },
        }}
      />
    </ThemeProvider>
  );
}
