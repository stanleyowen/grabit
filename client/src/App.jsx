import { AudioLines, ListVideo, MonitorPlay } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import Alert from "./components/Alert";
import DownloadsDock from "./components/DownloadsDock";
import Header from "./components/Header";
import PlaylistResult from "./components/PlaylistResult";
import ResultSkeleton from "./components/ResultSkeleton";
import UrlForm from "./components/UrlForm";
import VideoResult from "./components/VideoResult";
import { useDownloads } from "./hooks/useDownloads";
import { useTheme } from "./hooks/useTheme";
import { api } from "./lib/api";

const FEATURES = [
  { Icon: MonitorPlay, title: "Up to 4K", text: "MP4 that plays on every device." },
  { Icon: AudioLines, title: "Audio only", text: "MP3, or lossless-copy M4A." },
  { Icon: ListVideo, title: "Whole playlists", text: "Pick the videos you want." },
];

export default function App() {
  const [theme, setTheme] = useTheme();
  const downloads = useDownloads();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const lastUrl = useRef("");
  const abortRef = useRef(null);

  const lookup = useCallback(async (url) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    lastUrl.current = url;
    setLoading(true);
    setError(null);
    setNotice(null);
    setInfo(null);
    try {
      setInfo(await api.info(url, ctrl.signal));
    } catch (err) {
      if (!ctrl.signal.aborted) setError({ message: err.message, retryable: err.retryable || err.status >= 500 });
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  const cancelLookup = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const enqueue = (entries) => {
    const { added, skipped } = downloads.add(Array.isArray(entries) ? entries : [entries]);
    if (skipped && !added) setNotice("Already in your downloads.");
    else if (skipped) setNotice(`Added ${added}. ${skipped} already in your downloads.`);
    else setNotice(null);
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <Header theme={theme} onThemeChange={setTheme} />

      {/* Leave room for the fixed downloads dock so it never hides content. */}
      <main className={`mx-auto w-full max-w-3xl flex-1 px-4 sm:px-6 ${downloads.items.length ? "pb-[55vh] sm:pb-40" : "pb-16"}`}>
        <section className={`transition-[padding] duration-300 ${info || loading ? "pt-6 pb-8" : "pt-14 pb-10 sm:pt-24"}`}>
          {!info && !loading && (
            <div className="mb-8 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Save any video for offline.</h1>
              <p className="mx-auto mt-3 max-w-md text-[15px] text-pretty text-muted">
                Paste a link to a video, Short or playlist. Pick a quality. That's it.
              </p>
            </div>
          )}

          <UrlForm onSubmit={lookup} onCancel={cancelLookup} loading={loading} />

          <div className="mt-4 space-y-3 empty:hidden">
            {error && (
              <Alert
                onDismiss={() => setError(null)}
                action={
                  error.retryable && (
                    <button type="button" onClick={() => lookup(lastUrl.current)} className="font-semibold underline-offset-2 hover:underline">
                      Retry
                    </button>
                  )
                }
              >
                {error.message}
              </Alert>
            )}
            {notice && <p className="text-center text-sm text-muted">{notice}</p>}
          </div>
        </section>

        {loading && <ResultSkeleton />}

        {info?.type === "video" && (
          <VideoResult
            key={info.id}
            info={info}
            onDownload={enqueue}
            onSave={downloads.save}
            onOpenPlaylist={lookup}
            existing={downloads.byUrl.get(info.url)}
          />
        )}
        {info?.type === "playlist" && <PlaylistResult key={info.id} playlist={info} onDownload={enqueue} byUrl={downloads.byUrl} />}

        {!info && !loading && (
          <ul className="grid gap-3 sm:grid-cols-3">
            {FEATURES.map(({ Icon, title, text }) => (
              <li key={title} className="rounded-xl border border-line bg-surface/60 p-4">
                <Icon className="size-5 text-accent" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold">{title}</p>
                <p className="mt-0.5 text-sm text-muted">{text}</p>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="px-4 pb-6 text-center text-xs text-muted">
        For personal use only. Respect creators and copyright.
      </footer>

      <DownloadsDock downloads={downloads} />
    </div>
  );
}
