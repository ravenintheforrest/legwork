// The fleet, as the runner sees it. Adding an agent is one registry entry plus one
// module here.

import type { AgentDef } from "../types.js";
import { discover } from "./discover.js";
import { discoverGitlab } from "./discover-gitlab.js";
import { resolve } from "./resolve.js";
import { enrich } from "./enrich.js";
import { dedupe } from "./dedupe.js";
import { qualify } from "./qualify.js";
import { intent } from "./intent.js";
import { people } from "./people.js";
import { brief } from "./brief.js";

export const AGENTS: Record<string, AgentDef> = {
  discover,
  "discover-gitlab": discoverGitlab,
  resolve,
  enrich,
  dedupe,
  qualify,
  intent,
  people,
  brief,
};

export const PIPELINE = ["discover", "discover-gitlab", "resolve", "enrich", "dedupe", "qualify", "intent", "people", "brief"];
