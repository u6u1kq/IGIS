// SPDX-License-Identifier: Apache-2.0

/**
 * 只声明本仓库用到的 Node 内置模块。
 * 不安装 @types/node。这些声明放在同一份编译里，供各包共用。
 */
declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
  export function randomFillSync<T extends Uint8Array>(buffer: T): T;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, options: { readonly encoding: "utf8" }): string;
}

declare module "node:fs/promises" {
  export interface FileStat {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  }
  export function lstat(path: string): Promise<FileStat>;
  export function mkdir(path: string): Promise<void>;
  export function mkdir(path: string, options: { readonly recursive: true }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function symlink(target: string, path: string, type: "junction"): Promise<void>;
  export function writeFile(path: string, data: string, options: { readonly encoding: "utf8" }): Promise<void>;
  export function writeFile(path: string, data: string, options: { readonly encoding: "utf8"; readonly flag: "wx" }): Promise<void>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
  export function writeFile(path: string, data: Uint8Array, options: { readonly flag: "wx" }): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, options: { readonly encoding: "utf8" }): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { readonly recursive: true }): Promise<string[]>;
  export function stat(path: string): Promise<FileStat>;
  export function cp(source: string, destination: string, options: { readonly recursive: true; readonly dereference: true; readonly filter?: (source: string) => boolean }): Promise<void>;
  export function rm(path: string, options: { readonly recursive: true; readonly force: true }): Promise<void>;
  export function realpath(path: string): Promise<string>;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:process" {
  export const env: Record<string, string | undefined>;
  export const platform: string;
  export const arch: string;
  export function cwd(): string;
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: readonly string[]): string;
  export const sep: string;
}

declare module "node:child_process" {
  export interface ChildProcessBridge {
    stdin: { write(data: string): boolean; end(): void };
    stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
    stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
    kill(): void;
  }
  export function spawn(command: string, args?: readonly string[], options?: Record<string, unknown>): ChildProcessBridge;
}

declare module "node:module" {
  export interface NodeRequireFunction {
    (id: string): unknown;
    resolve(id: string): string;
  }
  export function createRequire(filename: string | URL): NodeRequireFunction;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}

/** 试用界面的本机 HTTP。不是 gis-io 的回退端口。 */
declare module "node:http" {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Record<string, string | undefined>;
    resume(): void;
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
  }
  export interface ServerResponse {
    writeHead(status: number, headers: Readonly<Record<string, string>>): void;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
  }
  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

/** 上传处理用到的 Buffer。只声明用到的方法。 */
interface Buffer extends Uint8Array {
  indexOf(value: Buffer | number, fromIndex?: number): number;
  subarray(start: number, end: number): Buffer;
  toString(encoding?: "ascii" | "utf8" | "latin1"): string;
}

declare var Buffer: {
  isBuffer(value: unknown): value is Buffer;
  from(data: string | Uint8Array): Buffer;
  concat(list: readonly Buffer[], totalLength?: number): Buffer;
};
