import { Film } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../lib/format";

export default function Thumbnail({ src, duration, className = "", eager = false }) {
  const [failed, setFailed] = useState(false);
  const time = formatDuration(duration);

  return (
    <div className={`relative overflow-hidden bg-subtle ${className}`}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
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
