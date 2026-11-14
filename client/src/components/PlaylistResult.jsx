import { Check, ChevronDown, Download, Minus } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDuration } from "../lib/format";
import StatusBadge from "./StatusBadge";
import Thumbnail from "./Thumbnail";

const QUALITIES = [
  { id: "4320p", label: "Best available" },
  { id: "1080p", label: "Up to 1080p" },
  { id: "720p", label: "Up to 720p" },
  { id: "480p", label: "Up to 480p" },
  { id: "360p", label: "Up to 360p" },
  { id: "mp3", label: "Audio · MP3" },
  { id: "m4a", label: "Audio · M4A" },
];

function Checkbox({ state, className = "" }) {
  const on = state === true;
  const mixed = state === "mixed";
  return (
    <span
      aria-hidden="true"
      className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors ${
        on || mixed ? "border-fg bg-fg text-bg" : "border-line-strong bg-surface"
      } ${className}`}
    >
      {on && <Check className="size-3" strokeWidth={3} />}
      {mixed && <Minus className="size-3" strokeWidth={3} />}
    </span>
  );
}

export default function PlaylistResult({ playlist, onDownload, byUrl }) {
  const available = useMemo(() => playlist.entries.filter((e) => e.available), [playlist]);
  const [selected, setSelected] = useState(() => new Set(available.map((e) => e.id)));
  const [quality, setQuality] = useState("1080p");

  const allState = selected.size === 0 ? false : selected.size === available.length ? true : "mixed";
  const toggleAll = () => setSelected(allState === true ? new Set() : new Set(available.map((e) => e.id)));
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const totalSeconds = available.filter((e) => selected.has(e.id)).reduce((s, e) => s + (e.duration || 0), 0);

  const start = () =>
    onDownload(
      available
        .filter((e) => selected.has(e.id))
        .map((e) => ({ url: e.url, title: e.title, thumbnail: e.thumbnail, quality })),
    );

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card" aria-label="Playlist">
      <div className="border-b border-line p-5 sm:p-6">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">Playlist</p>
        <h2 className="mt-1 text-lg leading-snug font-semibold tracking-tight text-balance">{playlist.title}</h2>
        <p className="mt-1 text-sm text-muted">
          {[playlist.channel, `${playlist.total} videos`].filter(Boolean).join(" · ")}
          {playlist.truncated && ` · showing first ${playlist.entries.length}`}
        </p>
      </div>

      {/* Sticky action bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface/90 px-5 py-3 backdrop-blur sm:px-6">
        <button type="button" onClick={toggleAll} className="flex items-center gap-2.5 text-sm font-medium" aria-pressed={allState === true}>
          <Checkbox state={allState} />
          {selected.size} of {available.length} selected
          {totalSeconds > 0 && <span className="font-normal text-muted tabular">· {formatDuration(totalSeconds)}</span>}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <label htmlFor="pl-quality" className="sr-only">
              Quality
            </label>
            <select
              id="pl-quality"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              className="appearance-none rounded-lg border border-line bg-surface py-2 pr-8 pl-3 text-sm font-medium hover:border-line-strong"
            >
              {QUALITIES.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" />
          </div>
          <button
            type="button"
            onClick={start}
            disabled={selected.size === 0}
            className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-30"
          >
            <Download className="size-4" />
            Download {selected.size || ""}
          </button>
        </div>
      </div>

      <ul className="divide-y divide-line">
        {playlist.entries.map((e) => {
          const isOn = selected.has(e.id);
          return (
            <li key={`${e.index}-${e.id}`}>
              <label
                className={`flex items-center gap-3 px-5 py-2.5 sm:gap-4 sm:px-6 ${
                  e.available ? "cursor-pointer hover:bg-subtle/60" : "cursor-not-allowed opacity-45"
                }`}
              >
                <input type="checkbox" className="peer sr-only" checked={isOn} disabled={!e.available} onChange={() => toggle(e.id)} />
                <Checkbox state={isOn} className="peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
                <span className="w-6 shrink-0 text-right text-xs text-muted tabular">{e.index}</span>
                <Thumbnail src={e.thumbnail} duration={e.duration} className="aspect-video w-24 shrink-0 rounded-md sm:w-28" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm leading-snug font-medium">{e.title}</span>
                  {!e.available && <span className="text-xs text-muted">Unavailable</span>}
                </span>
                <StatusBadge item={byUrl.get(e.url)} />
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
