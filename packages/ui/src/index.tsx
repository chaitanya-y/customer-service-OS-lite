"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

export type ThemePreference = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "cso-theme-preference";

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function applyTheme(preference: ThemePreference) {
  const resolvedTheme = preference === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : preference;

  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      setPreference(stored);
    }
  }, []);

  useEffect(() => {
    applyTheme(preference);
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [preference]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (preference === "system") applyTheme("system");
    };

    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, [preference]);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeScript() {
  const script = `(function () {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var preference = localStorage.getItem(key) || "system";
    var theme = preference === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
  })();`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

export function ThemeControl() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("ThemeControl must be rendered inside ThemeProvider");
  }

  return (
    <label className="cso-theme-control">
      <span className="cso-visually-hidden">Choose theme</span>
      <select
        aria-label="Choose theme"
        onChange={(event) => context.setPreference(event.target.value as ThemePreference)}
        value={context.preference}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
