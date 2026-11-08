import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
  name: string,
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    response.writeHead(400).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const path = join(directory, name);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw Error();
    size = stat.size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const extension = name.split(".").at(-1);
  const contentType =
    extension === "mp4"
      ? "video/mp4"
      : extension === "vtt"
        ? "text/vtt; charset=utf-8"
        : extension === "jpg"
          ? "image/jpeg"
          : "text/plain; charset=utf-8";
  const headers = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };
  let start = 0,
    end = size - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : end;
      }
    } else {
      start = -1;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      response
        .writeHead(416, { ...headers, "content-range": `bytes */${size}` })
        .end();
      return;
    }
  }
  response.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": end - start + 1,
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
