// SPDX-License-Identifier: Apache-2.0

/** 内核的友好错误。消息是中文，不含坐标。调用方捕获后返回页面，进程不退出。 */
export class SurtGisCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurtGisCoreError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
