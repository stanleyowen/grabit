import { Check, CircleAlert, Clock, LoaderCircle } from "lucide-react";

/** Compact per-row status used in playlist rows. */
export default function StatusBadge({ item }) {
  if (!item) return null;
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular";
  switch (item.status) {
    case "pending":
    case "queued":
      return (
        <span className={`${base} bg-subtle text-muted`}>
          <Clock className="size-3" /> {item.position ? `#${item.position}` : "Queued"}
        </span>
      );
    case "running":
      return (
        <span className={`${base} bg-accent-soft text-accent`}>
          <LoaderCircle className="size-3 animate-spin" /> {item.progress > 0 ? `${item.progress}%` : "Starting"}
        </span>
      );
    case "ready":
      return (
        <span className={`${base} bg-ok-soft text-ok`}>
          <Check className="size-3" /> Ready
        </span>
      );
    case "error":
      return (
        <span className={`${base} bg-danger-soft text-danger`} title={item.error || undefined}>
          <CircleAlert className="size-3" /> Failed
        </span>
      );
    default:
      return null;
  }
}
