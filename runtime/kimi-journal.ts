/** Marker for a framed journal line that is not valid JSON. */
export const UNPARSEABLE_JOURNAL_LINE: unique symbol = Symbol("unparseable-journal-line");

export interface KimiJournalLine {
  readonly line: string;
  readonly parsed: unknown;
  /** False only for a final line with no trailing "\n". */
  readonly terminated: boolean;
}

/**
 * kimi-code's append-log framing (appendLogStore.read/parseLine, identical at
 * 2.4.0 and 2.7.3): one TextDecoder over the stream, split on "\n" only, strip
 * ONE trailing "\r", skip only a zero-length line, else JSON.parse. A
 * terminated line that fails to parse is corruption and wire replay stops
 * there; an unparseable unterminated last line is dropped as truncated.
 */
export async function* kimiJournalRecords(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<KimiJournalLine> {
  const decoder = new TextDecoder();
  let pending = "";
  const frame = (raw: string, terminated: boolean): KimiJournalLine | undefined => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) return undefined;
    try {
      return { line, parsed: JSON.parse(line) as unknown, terminated };
    } catch {
      return { line, parsed: UNPARSEABLE_JOURNAL_LINE, terminated };
    }
  };
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const framed = frame(pending.slice(0, newline), true);
      pending = pending.slice(newline + 1);
      if (framed !== undefined) yield framed;
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    const framed = frame(pending, false);
    if (framed !== undefined) yield framed;
  }
}
