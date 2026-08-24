import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export function isPublicIp(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return !(
      a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  if (address === "::" || address === "::1") return false;
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (mapped) return isPublicIp(mapped);
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  if (address.startsWith("2001:db8:") || address.startsWith("2001:2:") || address.startsWith("2001:10:")) return false;
  return true;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new Error(`refusing private or reserved address ${host}`);
    return;
  }
  const answers = await lookup(host, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error(`DNS returned no addresses for ${host}`);
  for (const answer of answers) {
    if (!isPublicIp(answer.address)) throw new Error(`refusing ${host}: DNS resolved to private or reserved address`);
  }
}
