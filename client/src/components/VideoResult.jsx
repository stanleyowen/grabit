import { Check, Download, ListVideo, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { ACTIVE } from "../hooks/useDownloads";
import { formatBytes, formatCount, formatDate } from "../lib/format";
import FormatPicker from "./FormatPicker";
import Thumbnail from "./Thumbnail";

function defaultFormat(formats) {
  // 1080p is the sweet spot for size vs quality; fall back to the best available.
  const video = formats.filter((f) => f.kind === "video");
  return (video.find((f) => f.id === "1080p") || video.find((f) => parseInt(f.id) < 1080) || video[0] || formats[0])?.id;
}

export default function VideoResult({ info, onDownload, onSave, onOpenPlaylist, existing }) {
  const [format, setFormat] = useState(() => defaultFormat(info.formats));
  const selected = info.formats.find((f) => f.id === format);
  const inProgress = existing && existing.quality === format && (existing.status === "pending" || ACTIVE.has(existing.status));
  const done = existing && existing.quality === format && existing.status === "ready";

  const meta = [info.channel, info.viewCount ? `${formatCount(info.viewCount)} views` : null, formatDate(info.uploadDate)].filter(Boolean);

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="grid gap-0 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Thumbnail src={info.thumbnail} duration={info.duration} eager className="aspect-video md:aspect-auto md:h-full md:min-h-56" />

        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div>
            <h2 className="line-clamp-2 text-lg leading-snug font-semibold tracking-tight text-balance">{info.title}</h2>
            {meta.length > 0 && <p className="mt-1.5 text-sm text-muted">{meta.join(" · ")}</p>}
          </div>

          {info.playlistUrl && (
            <button
              type="button"
              onClick={() => onOpenPlaylist(info.playlistUrl)}
              className="flex items-center gap-2 self-start rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg"
            >
              <ListVideo className="size-4" />
              This video is in a playlist — <span className="font-medium text-fg">open playlist</span>
            </button>
          )}

          {info.isLive ? (
            <p className="text-sm text-warn">Live streams can't be downloaded until they've ended.</p>
          ) : (
            <>
              <FormatPicker formats={info.formats} value={format} onChange={setFormat} />

              <button
                type="button"
                disabled={!selected || inProgress}
                onClick={() =>
                  done ? onSave(existing.key) : onDownload({ url: info.url, title: info.title, thumbnail: info.thumbnail, quality: format })
                }
                className="flex items-center justify-center gap-2 rounded-xl bg-fg px-5 py-3 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {inProgress ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" /> In your downloads
                  </>
                ) : done ? (
                  <>
                    <Check className="size-4" /> Ready — save again
                  </>
                ) : (
                  <>
                    <Download className="size-4" />
                    Download {selected?.label}
                    {selected?.size ? <span className="font-normal opacity-60">· ≈ {formatBytes(selected.size)}</span> : null}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
