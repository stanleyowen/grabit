export default function ResultSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card" aria-busy="true" aria-label="Loading">
      <div className="grid md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="md:p-6 md:pr-0">
          <div className="skeleton aspect-video md:rounded-xl" />
        </div>
        <div className="space-y-4 p-6">
          <div className="skeleton h-5 w-4/5 rounded" />
          <div className="skeleton h-4 w-2/5 rounded" />
          <div className="grid grid-cols-3 gap-2 pt-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-12 rounded-xl" />
            ))}
          </div>
          <div className="skeleton h-11 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
