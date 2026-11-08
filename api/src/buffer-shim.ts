import { Buffer as BufferPolyfill } from "buffer";

if (typeof globalThis !== "undefined") {
  (globalThis as any).global = globalThis;
  (globalThis as any).Buffer = BufferPolyfill;
  if (!(globalThis as any).process) {
    (globalThis as any).process = { env: { NODE_ENV: "production" }, version: "", browser: true };
  }
}

export const Buffer = BufferPolyfill;
export const process = (globalThis as any).process;
