import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { DEFAULT_THEME, THEME_INIT_SCRIPT } from "@/components/theme/theme-script";
import "./globals.css";

// Manrope is a variable font; the design system only uses weights 300–700 (see globals.css).
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "EmployAI — Build your Business' AI Workforce",
  description:
    "Describe your business in plain language. EmployAI designs a team of specialised AI agents, builds their workflows, and runs them safely under your rules. A NEAR HACKATHON 2026 prototype.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F6F6" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Server default is Dark Mode (also without JavaScript); THEME_INIT_SCRIPT applies a stored choice
    // before first paint, so React must not warn about the attribute.
    <html lang="en" data-theme={DEFAULT_THEME} data-scroll-behavior="smooth" suppressHydrationWarning className={`${manrope.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Without JavaScript, scroll-reveal content must still be visible. */}
        <noscript>
          <style>{`.reveal{opacity:1!important;transform:none!important}.flow-step{opacity:1!important;transform:none!important}.film-track{display:none!important}.film-static{position:static!important;width:auto!important;height:auto!important;margin:0!important;overflow:visible!important;clip:auto!important;clip-path:none!important;white-space:normal!important}`}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
