// The fleet, as the runner sees it. Adding an agent is one registry entry plus one
// module here.

import type { AgentDef } from "../types.js";
import { discover } from "./discover.js";
import { resolve } from "./resolve.js";
import { qualify } from "./qualify.js";
import { brief } from "./brief.js";

export const AGENTS: Record<string, AgentDef> = { discover, resolve, qualify, brief };

export const PIPELINE = ["discover", "resolve", "qualify", "brief"];
