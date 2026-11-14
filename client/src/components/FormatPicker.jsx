import { formatBytes } from "../lib/format";

function Option({ format, checked, onChange, name }) {
  const size = formatBytes(format.size);
  const meta = [format.detail, format.fps ? `${format.fps}fps` : null].filter(Boolean).join(" · ");
  return (
    <label
      className={`group relative flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors ${
        checked ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"
      }`}
    >
      <input type="radio" name={name} value={format.id} checked={checked} onChange={() => onChange(format.id)} className="sr-only" />
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{format.label}</span>
        {size && <span className="tabular text-xs text-muted">≈ {size}</span>}
      </span>
      {meta && <span className="mt-0.5 text-xs text-muted">{meta}</span>}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-xl ring-accent group-has-[:focus-visible]:ring-2`}
      />
    </label>
  );
}

export default function FormatPicker({ formats, value, onChange }) {
  const video = formats.filter((f) => f.kind === "video");
  const audio = formats.filter((f) => f.kind === "audio");
  const group = (title, list) =>
    list.length > 0 && (
      <fieldset>
        <legend className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{title}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map((f) => (
            <Option key={f.id} name="format" format={f} checked={value === f.id} onChange={onChange} />
          ))}
        </div>
      </fieldset>
    );

  return (
    <div className="space-y-4">
      {group("Video · MP4", video)}
      {group("Audio only", audio)}
    </div>
  );
}
