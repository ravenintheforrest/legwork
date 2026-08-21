#!/usr/bin/env node
// The MCP face of the harness: the same reads `legwork status`, `show`, and `review`
// print, handed to a model instead of a terminal. Read-only — no tool here writes to
// data/, briefs/, or packs/.
//
// Register it with:  claude mcp add legwork -- npx tsx src/mcp.ts
//
// stdout carries the JSON-RPC stream and nothing else. Every diagnostic goes to stderr;
// a stray console.log in this process corrupts the protocol. That is also why an MCP
// client must spawn `npx tsx src/mcp.ts` and not `npm run mcp` — npm prints its script
// banner to stdout. The "mcp" script is for humans checking the server starts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentStats, fleetAccounts, fleetFindings, readBrief, reviewQueue } from "./fleetdata.js";

const server = new McpServer({ name: "legwork", version: "0.1.0" });

server.registerTool(
  "fleet_findings",
  {
    title: "Fleet findings",
    description:
      "Accounts the fleet qualified or briefed within the last since_days days, highest confidence first, each with up to three evidence receipts and its brief path. After `legwork demo` these are authored fixture accounts, not live research.",
    inputSchema: {
      since_days: z.number().int().positive().max(3650).optional().describe("look-back window in days; defaults to 7"),
    },
  },
  ({ since_days }) => json(fleetFindings(since_days ?? 7)),
);

server.registerTool(
  "fleet_status",
  {
    title: "Fleet status",
    description:
      "Per-agent totals from the run log: runs, ok/error/cost-ceiling-kill counts, tokens, dollars, and last outcome. Empty until the fleet has run at least once.",
    inputSchema: {},
  },
  () => json(agentStats()),
);

server.registerTool(
  "account_show",
  {
    title: "Show account",
    description:
      "The full stored record for one account: stage, segment, confidence, every evidence receipt with its URL, and the qualification decision. Takes the org key that fleet_findings returns.",
    inputSchema: { org: z.string().describe("account org key, e.g. \"partiful\"") },
  },
  ({ org }) => {
    const accounts = fleetAccounts();
    const needle = org.toLowerCase();
    const account =
      accounts.find((a) => a.org === org) ??
      accounts.find((a) => a.org.toLowerCase() === needle || a.domain?.toLowerCase() === needle);
    if (!account) {
      const known = accounts.map((a) => a.org).join(", ");
      return failure(
        known === ""
          ? `no account "${org}": no accounts recorded yet — run \`legwork demo\` or \`legwork run\``
          : `no account "${org}". Known orgs: ${known}`,
      );
    }
    return json(account);
  },
);

server.registerTool(
  "brief_read",
  {
    title: "Read brief",
    description:
      "The full markdown brief for one account, from briefs/ if it cleared the confidence gate or briefs/queue/ if it is still waiting on a human reviewer.",
    inputSchema: { org: z.string().describe("account org key, e.g. \"partiful\"") },
  },
  ({ org }) => {
    const brief = readBrief(org);
    return brief === undefined
      ? failure(`no brief for "${org}" in briefs/ or briefs/queue/ — only qualified accounts get briefed`)
      : text(brief);
  },
);

server.registerTool(
  "review_queue",
  {
    title: "Review queue",
    description:
      "Briefs held for a human because their confidence fell below the registry's review gate, plus the gate value they missed.",
    inputSchema: {},
  },
  () => json(reviewQueue()),
);

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

// A missing account or brief is the caller's problem to handle, not a transport fault:
// report it as a tool-level error so the model can correct its argument and retry.
function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("legwork mcp: read-only server on stdio · 5 tools");
}

main().catch((err: unknown) => {
  console.error(`legwork mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
