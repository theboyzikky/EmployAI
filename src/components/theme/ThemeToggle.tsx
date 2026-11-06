"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, MoonIcon, SunIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { THEME_STORAGE_KEY, type Theme } from "./theme-script";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* private mode: theme still applies for this page */ }
}

/**
 * Light / Dark toggle. Changes the whole site via the `data-theme` attribute on <html>,
 * persists the choice in localStorage (survives navigation and refresh), and syncs across tabs.
 * Icons show the theme you will switch TO and are visible before hydration (CSS-driven).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    // Keep every toggle on the page in sync (desktop + mobile instances) by watching <html>.
    const mo = new MutationObserver(() => setTheme(currentTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Sync with other tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && (e.newValue === "light" || e.newValue === "dark")) {
        document.documentElement.setAttribute("data-theme", e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => { mo.disconnect(); window.removeEventListener("storage", onStorage); };
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }, []);

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className={cx("icon-btn icon-host", className)}
      aria-label={theme === null ? "Toggle dark mode" : isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="theme-icon-to-dark"><Icon icon={MoonIcon} size={20} /></span>
      <span className="theme-icon-to-light"><Icon icon={SunIcon} size={20} /></span>
    </button>
  );
}
