// SPDX-License-Identifier: Apache-2.0

/**
 * 本机页面来源。服务监听 127.0.0.1。
 * 这不是登录，也不建立用户账号。
 * 它阻止网页用另一个 Origin 绕过 AI 网关，直接调用本机 GIS 接口。
 * 不把 http://localhost:<端口> 算作允许来源：那是另一个 Origin，代码没有第二份站点。
 */
export function pageOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * 没有 Origin 时允许。curl 和本机非浏览器客户端通常不发送 Origin。
 * 浏览器跨站请求总会带 Origin。带了 Origin 时只允许本机页面来源。
 * 这不是登录。字符串 "null"（不透明来源）不等于缺省，会拒绝。
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === "") return true;
  return origin === pageOrigin(port);
}

export function originFromHeader(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** 返回几何、文件、导出或配置的 GET。成功与否都先过门，避免处理函数先读出内容。 */
export function isSensitiveRead(pathname: string): boolean {
  if (pathname === "/api/llm/config" || pathname === "/api/settings") return true;
  if (pathname === "/api/foundation/file" || pathname === "/api/documents/file") return true;
  if (/^\/api\/map\/layers\/[A-Za-z0-9_-]+\/geojson$/.test(pathname)) return true;
  return false;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 这些请求必须先通过 isAllowedOrigin，然后才能进入业务处理函数。
 * OPTIONS 由调用方单独处理：不改状态，也不把外来 Origin 写进 Allow-Origin。
 */
export function requiresOriginGate(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (MUTATING.has(verb)) return true;
  if (verb === "GET" || verb === "HEAD") return isSensitiveRead(pathname);
  return verb !== "OPTIONS";
}

/**
 * 只在 Origin 正好是本机页面时回显该来源。
 * 不回显其他 Origin，也不使用 *。没有 Origin 时不发这组头。
 */
export function corsHeadersForAllowedPage(origin: string | undefined, port: number): Record<string, string> {
  if (origin !== pageOrigin(port)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    Vary: "Origin",
  };
}
