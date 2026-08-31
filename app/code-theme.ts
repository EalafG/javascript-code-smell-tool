import { useCallback, useState } from "react";

export type CodeTheme = "light" | "dark";

const CODE_THEME_STORAGE_KEY = "upm-code-viewer-theme";

export function useCodeThemePreference(): [CodeTheme, (theme: CodeTheme) => void] {
  const [theme, setThemeState] = useState<CodeTheme>(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem(CODE_THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  });

  const setTheme = useCallback((nextTheme: CodeTheme) => {
    setThemeState(nextTheme);
    localStorage.setItem(CODE_THEME_STORAGE_KEY, nextTheme);
  }, []);

  return [theme, setTheme];
}
