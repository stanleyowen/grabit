import { ArrowDownToLine, ChevronDown, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACTIVE, FINISHED } from "../hooks/useDownloads";
import { QUALITY_LABEL, formatBytes, formatEta } from "../lib/format";
import Thumbnail from "./Thumbnail";

function statusLine(item) {
  switch (item.status) {
    case "pending":
      return item.note ? `Waiting — ${item.note}` : "Waiting…";
    case "queued":
      return item.position ? `In queue · #${item.position}` : "In queue";
    case "running": {
      if (item.phase === "processing") return "Finishing up…";
      if (item.phase === "retrying") return "Retrying…";
      if (item.phase === "starting" || !item.progress) return "Starting…";
      const bits = [`${item.progress}%`];
      const speed = formatBytes(item.speed);
      if (speed) bits.push(`${speed}/s`);
      const eta = formatEta(item.eta);
      if (eta) bits.push(eta);
      return bits.join(" · ");
    }
    case "ready":
      return [item.saved ? "Saved" : "Ready", formatBytes(item.size)].filter(Boolean).join(" · ");
    case "cancelled":
      return "Cancelled";
    default:
      return item.error || "Failed";
  }
}

function IconButton({ label, onClick, children, tone = "default" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors ${
        tone === "primary" ? "bg-fg text-bg hover:opacity-90" : "text-muted hover:bg-subtle hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function Row({ item, actions }) {
  const active = item.status === "pending" || ACTIVE.has(item.status);
  const failed = item.status === "error" || item.status === "expired";
  const pct = item.status === "ready" ? 100 : item.progress || 0;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Thumbnail src={item.thumbnail} className="aspect-video w-16 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium" title={item.title}>
            {item.title}
          </p>
          <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-[10px] font-semibold tracking-wide text-muted uppercase">
            {QUALITY_LABEL(item.quality)}
          </span>
        </div>
        <p className={`mt-0.5 truncate text-xs tabular ${failed ? "text-danger" : "text-muted"}`} aria-live="polite">
          {statusLine(item)}
        </p>
        {active && (
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-subtle"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`${item.title} progress`}
          >
            <div
              className={`h-full rounded-full bg-accent transition-[width] duration-500 ${
                item.status === "running" && pct > 0 ? "" : "w-1/4 animate-pulse opacity-40"
              }`}
              style={item.status === "running" && pct > 0 ? { width: `${pct}%` } : undefined}
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {item.status === "ready" && (
          <IconButton label="Save file" tone="primary" onClick={() => actions.save(item.key)}>
            <ArrowDownToLine className="size-4" />
          </IconButton>
        )}
        {(failed || item.status === "cancelled") && (
          <IconButton label="Try again" onClick={() => actions.retry(item.key)}>
            <RotateCw className="size-4" />
          </IconButton>
        )}
        {active ? (
          <IconButton label="Cancel" onClick={() => actions.cancel(item.key)}>
            <X className="size-4" />
          </IconButton>
        ) : (
          <IconButton label="Remove from list" onClick={() => actions.remove(item.key)}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

export default function DownloadsDock({ downloads }) {
  const { items, autoSave, setAutoSave, clearFinished, cancelAll } = downloads;
  const [open, setOpen] = useState(true);
  const prevCount = useRef(items.length);

  // Pop open whenever something new is added.
  useEffect(() => {
    if (items.length > prevCount.current) setOpen(true);
    prevCount.current = items.length;
  }, [items.length]);

  if (items.length === 0) return null;

  const active = items.filter((i) => i.status === "pending" || ACTIVE.has(i.status));
  const ready = items.filter((i) => i.status === "ready").length;
  const failed = items.filter((i) => i.status === "error" || i.status === "expired").length;
  const finished = items.filter((i) => FINISHED.has(i.status)).length;
  const overall = active.length ? Math.round(active.reduce((s, i) => s + (i.progress || 0), 0) / active.length) : 100;

  const summary = [
    active.length && `${active.length} in progress`,
    ready && `${ready} ready`,
    failed && `${failed} failed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside
      aria-label="Downloads"
      className="fixed inset-x-0 bottom-0 z-40 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[400px]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="overflow-hidden border-t border-line bg-surface shadow-dock sm:rounded-2xl sm:border">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="relative flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <span className="flex-1">
            <span className="block text-sm font-semibold">Downloads</span>
            <span className="block text-xs text-muted tabular">{summary || "All done"}</span>
          </span>
          {active.length > 0 && overall > 0 && <span className="text-xs font-medium text-muted tabular">{overall}%</span>}
          <ChevronDown className={`size-4 text-muted transition-transform ${open ? "" : "rotate-180"}`} />
          {active.length > 0 && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-subtle">
              <span className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${overall}%` }} />
            </span>
          )}
        </button>

        {open && (
          <>
            <ul className="max-h-[min(38vh,420px)] divide-y divide-line overflow-y-auto overscroll-contain border-t border-line">
              {items.map((item) => (
                <Row key={item.key} item={item} actions={downloads} />
              ))}
            </ul>
            <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-xs">
              <label className="flex cursor-pointer items-center gap-2 text-muted select-none">
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => setAutoSave(e.target.checked)}
                  className="size-3.5 accent-[var(--color-accent)]"
                />
                Save automatically
              </label>
              <span className="ml-auto flex gap-3">
                {active.length > 1 && (
                  <button type="button" onClick={cancelAll} className="font-medium text-muted hover:text-fg">
                    Cancel all
                  </button>
                )}
                {finished > 0 && (
                  <button type="button" onClick={clearFinished} className="font-medium text-muted hover:text-fg">
                    Clear finished
                  </button>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
