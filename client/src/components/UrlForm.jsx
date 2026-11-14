import { ArrowRight, ClipboardPaste, Link, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";

const looksLikeUrl = (s) => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(s.trim());

export default function UrlForm({ onSubmit, onCancel, loading }) {
  const [url, setUrl] = useState("");
  const inputRef = useRef(null);
  const canClipboard = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;

  const submit = (value = url) => {
    const v = value.trim();
    if (v && !loading) onSubmit(v);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      setUrl(text);
      if (looksLikeUrl(text)) submit(text);
    } catch {
      inputRef.current?.focus(); // permission denied — let them paste manually
    }
  };

  // Pasting a link fetches immediately: one less click for the common case.
  const onPaste = (e) => {
    const text = e.clipboardData.getData("text").trim();
    if (looksLikeUrl(text) && (url.trim() === "" || e.currentTarget.selectionStart === 0)) {
      e.preventDefault();
      setUrl(text);
      submit(text);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="w-full"
      role="search"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-card transition-colors focus-within:border-line-strong">
        <label htmlFor="url" className="sr-only">
          Video or playlist link
        </label>
        <Link className="ml-2 size-4 shrink-0 text-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          id="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={2048}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          placeholder="Paste a video or playlist link"
          className="min-w-0 flex-1 bg-transparent py-2.5 text-base outline-none placeholder:text-muted/80 focus-visible:outline-none"
          autoFocus
        />

        {url && !loading && (
          <button
            type="button"
            onClick={() => {
              setUrl("");
              inputRef.current?.focus();
            }}
            aria-label="Clear"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-fg"
          >
            <X className="size-4" />
          </button>
        )}

        {!url && canClipboard && (
          <button
            type="button"
            onClick={pasteFromClipboard}
            className="hidden shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-subtle hover:text-fg sm:flex"
          >
            <ClipboardPaste className="size-4" />
            Paste
          </button>
        )}

        {loading ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-subtle px-4 py-2.5 text-sm font-medium"
          >
            <LoaderCircle className="size-4 animate-spin" />
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            disabled={!url.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-fg px-4 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <span className="hidden sm:inline">Continue</span>
            <ArrowRight className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}
