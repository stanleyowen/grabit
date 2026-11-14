import { useEffect, useState } from "react";

const KEY = "theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** "system" | "light" | "dark", persisted per browser. */
export function useTheme() {
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media().matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {}
    if (theme !== "system") return;
    const mq = media();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return [theme, setTheme];
}
