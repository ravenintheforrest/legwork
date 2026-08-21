// The Slack adapter: the consumer surface every fleet in the literature converges on.
// A brief that clears the gate (or is approved by a reviewer) can be posted to an
// incoming webhook as the Slack-shaped short form the brief agent already renders.
// Without SLACK_WEBHOOK_URL it prints the message and says so — never a silent no-op.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function notifyBrief(org: string): Promise<"posted" | "printed" | "missing"> {
  const file = join("briefs", `${org}.slack.txt`);
  if (!existsSync(file)) return "missing";
  const text = readFileSync(file, "utf8").trim();
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log(`(no SLACK_WEBHOOK_URL — would post to Slack:)\n${text}`);
    return "printed";
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
  return "posted";
}
