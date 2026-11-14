const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");
const DOWNLOAD_BASE = (import.meta.env.VITE_DOWNLOAD_BASE || API_BASE).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message, { status = 0, code = "error", retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status === 503;
  }
}

const FALLBACK = {
  400: "That request wasn't valid.",
  404: "Not found.",
  413: "That's too large.",
  429: "Too many requests. Slow down a little.",
  502: "The server couldn't process this link.",
  503: "The server is busy. Try again shortly.",
  504: "The server took too long to respond.",
};

async function request(path, { method = "GET", body, timeout = 15_000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")), timeout);
  const forward = () => ctrl.abort(signal.reason);
  signal?.addEventListener("abort", forward, { once: true });

  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (res.status === 204) return null;

    // Never call res.json() blindly: proxies return HTML error pages, and
    // Safari's parse error ("The string did not match the expected pattern")
    // is meaningless to users.
    let data = null;
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      data = await res.json().catch(() => null);
    }
    if (!res.ok) {
      throw new ApiError(data?.error?.message || FALLBACK[res.status] || "Something went wrong.", {
        status: res.status,
        code: data?.error?.code,
        retryAfter: Number(res.headers.get("Retry-After")) || null,
      });
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw error;
    if (ctrl.signal.reason?.name === "TimeoutError") {
      throw new ApiError("The server took too long to respond.", { code: "timeout" });
    }
    throw new ApiError("Can't reach the server. Check your connection.", { code: "network" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

export const api = {
  info: (url, signal) => request("/info", { method: "POST", body: { url }, timeout: 90_000, signal }),
  createJob: (url, quality) => request("/jobs", { method: "POST", body: { url, quality } }),
  statuses: (ids) => request(`/jobs?ids=${ids.map(encodeURIComponent).join(",")}`),
  cancel: (id) => request(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  fileUrl: (id) => `${DOWNLOAD_BASE}/jobs/${encodeURIComponent(id)}/file`,
};
