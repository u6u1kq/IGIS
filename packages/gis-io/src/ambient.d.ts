// SPDX-License-Identifier: Apache-2.0

/**
 * 只声明回退客户端用到的 net。
 * 不安装 @types/node。这里没有 listen，路由不会在本进程打开端口。
 */
declare module "node:net" {
  export interface NetSocket {
    end(data: string): void;
    destroy(): void;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (error: unknown) => void): void;
  }
  export function createConnection(options: { readonly host: string; readonly port: number }): NetSocket;
}
