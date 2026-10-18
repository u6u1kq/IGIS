// SPDX-License-Identifier: Apache-2.0
import { cwd } from "node:process";
import { ensureManagedGdalEnv } from "@igis/external-gateway";

const result = await ensureManagedGdalEnv(cwd());
console.log(JSON.stringify(result));
