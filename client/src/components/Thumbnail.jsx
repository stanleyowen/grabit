import { Film } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../lib/format";

export default function Thumbnail({ src, fallback, duration, className = "", eager = false }) {
  // Try src, then fallback (e.g. HD image that may not exist -> sized one that does).
  const sources = [src, fallback].filter(Boolean);
  const [attempt, setAttempt] = useState(0);
  const current = sources[attempt];
  const time = formatDuration(duration);

  return (
    <div className={`relative overflow-hidden bg-subtle ${className}`}>
      {current ? (
        <img
          key={current}
          src={current}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setAttempt((a) => a + 1)}
          // YouTube answers a missing size with a 404 whose body is a 120x90
          // grey placeholder; browsers render it and fire onload, not onerror.
          onLoad={(e) => {
            if (attempt < sources.length - 1 && e.currentTarget.naturalWidth <= 120) setAttempt((a) => a + 1);
          }}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-muted">
          <Film className="size-5" aria-hidden="true" />
        </div>
      )}
      {time && (
        <span className="tabular absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] leading-none font-medium text-white">
          {time}
        </span>
      )}
    </div>
  );
}
