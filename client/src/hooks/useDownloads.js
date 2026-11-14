import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { randomId } from "../lib/format";

const STORAGE_KEY = "downloads:v2";
const AUTOSAVE_KEY = "autoSave";
const MAX_ITEMS = 500;
const MAX_IN_FLIGHT = 3; // per tab; server allows a few more so multiple tabs still work
const BATCH = 50;

export const ACTIVE = new Set(["queued", "running"]);
export const FINISHED = new Set(["ready", "error", "cancelled", "expired"]);

function load() {
  try {
    const items = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(items) ? items.slice(-MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

function reducer(state, action) {
  switch (action.type) {
    case "add":
      return [...state, ...action.items].slice(-MAX_ITEMS);
    case "patch":
      return state.map((i) => (i.key === action.key ? { ...i, ...action.fields } : i));
    case "remove":
      return state.filter((i) => i.key !== action.key);
    case "clearFinished":
      return state.filter((i) => !FINISHED.has(i.status));
    default:
      return state;
  }
}

const fromJob = (job) => ({
  jobId: job.id,
  status: job.status,
  progress: job.progress ?? 0,
  phase: job.phase,
  position: job.position,
  speed: job.speed,
  eta: job.eta,
  size: job.size,
  fileName: job.fileName,
  expiresAt: job.expiresAt,
  error: job.error?.message || null,
  note: null,
  retryAt: null,
});

function triggerBrowserDownload(jobId, fileName) {
  const a = document.createElement("a");
  a.href = api.fileUrl(jobId);
  a.download = fileName || "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Client-side download manager.
 * - Throttles submissions (MAX_IN_FLIGHT) so a 200-video playlist trickles in.
 * - Polls all active jobs with ONE batched request, slowing down when idle or
 *   when the tab is hidden.
 * - Honours Retry-After from the server.
 */
export function useDownloads() {
  const [items, setItems] = useState(load);
  // Source of truth lives in a ref so the async engine never reads stale state.
  const ref = useRef(items);
  const dispatch = useCallback((action) => {
    ref.current = reducer(ref.current, action);
    setItems(ref.current);
  }, []);

  const [autoSave, setAutoSaveState] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const autoSaveRef = useRef(autoSave);
  const setAutoSave = useCallback((v) => {
    autoSaveRef.current = v;
    setAutoSaveState(v);
    try {
      localStorage.setItem(AUTOSAVE_KEY, v ? "1" : "0");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items]);

  const submitting = useRef(new Set());
  const kickRef = useRef(() => {});

  const save = useCallback(
    (key) => {
      const item = ref.current.find((i) => i.key === key);
      if (!item || item.status !== "ready" || !item.jobId) return;
      if (item.expiresAt && item.expiresAt < Date.now()) {
        dispatch({ type: "patch", key, fields: { status: "expired", error: "This file expired. Download it again." } });
        return;
      }
      triggerBrowserDownload(item.jobId, item.fileName);
      dispatch({ type: "patch", key, fields: { saved: true } });
    },
    [dispatch],
  );

  // ---- engine -------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    let timer = null;
    let lastPoll = 0;
    let backoffUntil = 0;

    const schedule = (ms) => {
      clearTimeout(timer);
      if (alive) timer = setTimeout(tick, ms);
    };

    function submit(now) {
      let inFlight = ref.current.filter((i) => ACTIVE.has(i.status)).length + submitting.current.size;
      for (const item of ref.current) {
        if (inFlight >= MAX_IN_FLIGHT || now < backoffUntil) break;
        if (item.status !== "pending" || submitting.current.has(item.key) || (item.retryAt || 0) > now) continue;
        inFlight++;
        submitting.current.add(item.key);
        api
          .createJob(item.url, item.quality)
          .then((job) => {
            if (!ref.current.some((i) => i.key === item.key)) {
              api.cancel(job.id).catch(() => {}); // removed while submitting
              return;
            }
            dispatch({ type: "patch", key: item.key, fields: fromJob(job) });
          })
          .catch((err) => {
            if (err.retryable) {
              const wait = (err.retryAfter || 5) * 1000;
              if (err.status === 503) backoffUntil = Date.now() + wait;
              dispatch({ type: "patch", key: item.key, fields: { retryAt: Date.now() + wait, note: err.message } });
            } else {
              dispatch({ type: "patch", key: item.key, fields: { status: "error", error: err.message } });
            }
          })
          .finally(() => {
            submitting.current.delete(item.key);
            schedule(0);
          });
      }
    }

    async function poll(now) {
      const active = ref.current.filter((i) => i.jobId && ACTIVE.has(i.status));
      if (active.length === 0 || now < backoffUntil) return;
      const hidden = document.visibilityState === "hidden";
      const interval = hidden ? 5000 : active.some((i) => i.status === "running") ? 1000 : 2500;
      if (now - lastPoll < interval) return;
      lastPoll = now;

      for (let i = 0; i < active.length; i += BATCH) {
        const chunk = active.slice(i, i + BATCH);
        let jobs;
        try {
          ({ jobs } = await api.statuses(chunk.map((c) => c.jobId)));
        } catch (err) {
          if (err.status === 429 || err.status === 503) backoffUntil = Date.now() + (err.retryAfter || 5) * 1000;
          return;
        }
        for (const item of chunk) {
          const current = ref.current.find((c) => c.key === item.key);
          if (!current || !ACTIVE.has(current.status)) continue; // cancelled meanwhile
          const job = jobs[item.jobId];
          if (!job) {
            dispatch({ type: "patch", key: item.key, fields: { status: "expired", error: "This download expired on the server." } });
            continue;
          }
          dispatch({ type: "patch", key: item.key, fields: fromJob(job) });
          if (job.status === "ready" && autoSaveRef.current && !current.saved) save(item.key);
        }
      }
    }

    function expireReady(now) {
      for (const item of ref.current) {
        if (item.status === "ready" && item.expiresAt && item.expiresAt < now) {
          dispatch({ type: "patch", key: item.key, fields: { status: "expired", error: "This file expired. Download it again." } });
        }
      }
    }

    async function tick() {
      if (!alive) return;
      const now = Date.now();
      expireReady(now);
      submit(now);
      await poll(now);
      if (!alive) return;
      const busy = ref.current.some((i) => i.status === "pending" || (i.jobId && ACTIVE.has(i.status)));
      const hidden = document.visibilityState === "hidden";
      schedule(busy ? (hidden ? 5000 : 500) : 15_000);
    }

    kickRef.current = () => schedule(0);
    const onVisible = () => document.visibilityState === "visible" && schedule(0);
    document.addEventListener("visibilitychange", onVisible);
    schedule(0);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dispatch, save]);

  // ---- actions --------------------------------------------------------------
  const add = useCallback(
    (entries) => {
      const busy = new Set(
        ref.current.filter((i) => !["error", "cancelled", "expired"].includes(i.status)).map((i) => `${i.quality}|${i.url}`),
      );
      const fresh = entries
        .filter((e) => e.url && !busy.has(`${e.quality}|${e.url}`))
        .map((e) => ({
          key: randomId(),
          url: e.url,
          quality: e.quality,
          title: e.title,
          thumbnail: e.thumbnail || null,
          status: "pending",
          progress: 0,
          addedAt: Date.now(),
        }));
      if (fresh.length) {
        dispatch({ type: "add", items: fresh });
        kickRef.current();
      }
      return { added: fresh.length, skipped: entries.length - fresh.length };
    },
    [dispatch],
  );

  const cancel = useCallback(
    (key) => {
      const item = ref.current.find((i) => i.key === key);
      if (!item) return;
      if (item.jobId && ACTIVE.has(item.status)) api.cancel(item.jobId).catch(() => {});
      if (item.status === "pending") dispatch({ type: "remove", key });
      else dispatch({ type: "patch", key, fields: { status: "cancelled", error: null } });
    },
    [dispatch],
  );

  const remove = useCallback(
    (key) => {
      const item = ref.current.find((i) => i.key === key);
      if (item?.jobId && ACTIVE.has(item.status)) api.cancel(item.jobId).catch(() => {});
      dispatch({ type: "remove", key });
    },
    [dispatch],
  );

  const retry = useCallback(
    (key) => {
      dispatch({
        type: "patch",
        key,
        fields: { status: "pending", jobId: null, error: null, note: null, progress: 0, saved: false, retryAt: null, expiresAt: null },
      });
      kickRef.current();
    },
    [dispatch],
  );

  const cancelAll = useCallback(() => {
    for (const i of ref.current) if (i.status === "pending" || ACTIVE.has(i.status)) cancel(i.key);
  }, [cancel]);

  const clearFinished = useCallback(() => dispatch({ type: "clearFinished" }), [dispatch]);

  const byUrl = useMemo(() => {
    const m = new Map();
    for (const i of items) m.set(i.url, i);
    return m;
  }, [items]);

  return { items, byUrl, add, cancel, cancelAll, remove, retry, save, clearFinished, autoSave, setAutoSave };
}
