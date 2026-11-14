#!/usr/bin/env node
// Stand-in for yt-dlp used by the integration tests. Behaviour is driven by the URL.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const url = args[args.indexOf("--") + 1] || "";
const has = (f) => args.includes(f);
const val = (f) => args[args.indexOf(f) + 1];

if (has("--version")) {
  console.log("2099.01.01-fake");
  process.exit(0);
}
if (url.includes("unavailable")) {
  console.error("ERROR: [youtube] xxxxxxxxxxx: Video unavailable. /home/secret/path");
  process.exit(1);
}

if (has("-J")) {
  if (url.includes("envcheck")) {
    // Reports how the server launched us: proxy env + extractor policy.
    const proxied = /^http:\/\/grabit:[^@]+@127\.0\.0\.1:\d+$/.test(process.env.HTTPS_PROXY || "");
    const generic = val("--use-extractors") === "default";
    console.log(JSON.stringify({
      id: "envcheck", title: `proxy=${proxied} generic=${generic} noproxy=${process.env.NO_PROXY ?? "unset"}`,
      // Direct-link style: no height, no codec info.
      formats: [{ format_id: "0", ext: "mp4", url: "https://cdn.example/v.mp4", filesize: 5000 }],
    }));
    process.exit(0);
  }
  if (url.includes("playlist")) {
    console.log(JSON.stringify({
      _type: "playlist", id: "PL1", title: "Fake list", playlist_count: 2,
      entries: [
        { id: "aaaaaaaaaaa", title: "One", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", duration: 10 },
        { id: "bbbbbbbbbbb", title: "[Private video]", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
      ],
    }));
  } else {
    console.log(JSON.stringify({
      id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed", duration: 19, view_count: 1000,
      thumbnails: [{ url: "https://i.ytimg.com/a.jpg", width: 320 }, { url: "https://i.ytimg.com/b.jpg", width: 1280 }],
      formats: [
        { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 128, filesize: 300000 },
        { format_id: "134", vcodec: "avc1.4d401e", acodec: "none", width: 640, height: 360, filesize: 1000000, tbr: 300 },
        { format_id: "243", vcodec: "vp9", acodec: "none", width: 640, height: 360, filesize: 900000, tbr: 400 },
        { format_id: "18", vcodec: "avc1", acodec: "mp4a", width: 320, height: 240, filesize: 700000 },
      ],
    }));
  }
  process.exit(0);
}

// Download mode
const dir = val("-P");
const delay = url.includes("slow") ? 400 : 20;
const out = path.join(dir, "Me at the zoo.mp4");
const total = 1000;
let done = 0;
process.on("SIGTERM", () => process.exit(143));
const timer = setInterval(() => {
  done += 250;
  console.log(`PROG ${done} ${total} NA 5000 1 avc1`);
  if (done >= total) {
    clearInterval(timer);
    fs.writeFileSync(out, Buffer.alloc(total, 1));
    console.log(`FILE ${out}`);
    process.exit(0);
  }
}, delay);
