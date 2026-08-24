// JSONL is an append-friendly operational format. A torn or manually damaged line must
// not make every healthy record unreadable, so readers recover line by line.
export function parseJsonl<T>(source: string, file: string, warn = console.warn): T[] {
  const records: T[] = [];
  for (const [index, raw] of source.split("\n").entries()) {
    if (raw.trim() === "") continue;
    try {
      records.push(JSON.parse(raw) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`legwork: skipped malformed JSONL record ${file}:${index + 1}: ${reason}`);
    }
  }
  return records;
}
