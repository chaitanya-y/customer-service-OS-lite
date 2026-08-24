import "@cso/ui/styles.css";

import { ThemeProvider, ThemeScript } from "@cso/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Operations Console | Customer Service OS" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><ThemeScript /></head><body><ThemeProvider>{children}</ThemeProvider></body></html>;
}
