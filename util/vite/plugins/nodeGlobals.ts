/**
 * unenv's globals as a module of them, for esbuild's `inject` (polyfillNodeEsbuild): code written for Node reads
 * `process`, `Buffer`, `global` and `setImmediate` unimported, and esbuild injects each export where it's read.
 */
export { default as process } from "unenv/node/process";
export { Buffer } from "unenv/node/buffer";
export { clearImmediate, setImmediate } from "unenv/node/timers";

export const global = globalThis;
