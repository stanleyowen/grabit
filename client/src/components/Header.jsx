import { Monitor, Moon, Sun } from "lucide-react";

const THEMES = [
  { id: "system", label: "System theme", Icon: Monitor },
  { id: "light", label: "Light theme", Icon: Sun },
  { id: "dark", label: "Dark theme", Icon: Moon },
];

export function Logo({ className = "" }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path
        d="M16 8v11m0 0-4.5-4.5M16 19l4.5-4.5M10 23h12"
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Header({ theme, onThemeChange }) {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
      <a href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="Video Downloader home">
        <Logo className="size-8" />
        <span className="text-[15px] font-semibold tracking-tight">Downloader</span>
      </a>

      <div role="radiogroup" aria-label="Color theme" className="flex rounded-full border border-line bg-surface p-0.5">
        {THEMES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            aria-label={label}
            title={label}
            onClick={() => onThemeChange(id)}
            className={`grid size-7 place-items-center rounded-full transition-colors ${
              theme === id ? "bg-subtle text-fg" : "text-muted hover:text-fg"
            }`}
          >
            <Icon className="size-3.5" strokeWidth={2.25} />
          </button>
        ))}
      </div>
    </header>
  );
}
