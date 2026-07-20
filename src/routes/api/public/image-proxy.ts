// Server-side image proxy. Fetches an image from an allow-listed host and
// streams it back to the browser with permissive CORS headers, so the
// browser can hand the bytes to JS (bypassing the S3 bucket's missing
// Access-Control-Allow-Origin). Used as a fallback when a Totescan MHTML
// export did not embed the image bytes inline.
import { createFileRoute } from "@tanstack/react-router";

const ALLOWED_HOST_SUFFIXES = [
  ".amazonaws.com",
  ".totescan.com",
];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/public/image-proxy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url).searchParams.get("url");
        if (!url) {
          return new Response("missing url", { status: 400, headers: CORS });
        }
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          return new Response("invalid url", { status: 400, headers: CORS });
        }
        if (target.protocol !== "https:" && target.protocol !== "http:") {
          return new Response("bad protocol", { status: 400, headers: CORS });
        }
        const host = target.hostname.toLowerCase();
        const allowed = ALLOWED_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
        if (!allowed) {
          return new Response(`host not allowed: ${host}`, { status: 403, headers: CORS });
        }
        try {
          const r = await fetch(target.toString());
          if (!r.ok) {
            return new Response(`upstream ${r.status}`, { status: r.status, headers: CORS });
          }
          const contentType = r.headers.get("content-type") ?? "application/octet-stream";
          return new Response(r.body, {
            status: 200,
            headers: {
              ...CORS,
              "Content-Type": contentType,
              "Cache-Control": "private, max-age=300",
            },
          });
        } catch (e) {
          return new Response(`fetch failed: ${(e as Error).message}`, { status: 502, headers: CORS });
        }
      },
    },
  },
});
