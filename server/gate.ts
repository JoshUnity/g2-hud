/**
 * Claude replies with exactly "NONE" when the last utterance is not a question
 * for the wearer. The gate holds the first characters back until it can tell
 * "NONE" from a real answer, so nothing flashes on the glasses. The match is
 * case-sensitive: an answer may start with "None of them…" or "Nonetheless…".
 */
export type GateResult = { decision: "pending" } | { decision: "none" } | { decision: "answer"; text: string };

export class NoneGate {
  private buffer = "";
  private decided: "none" | "answer" | null = null;

  feed(delta: string): GateResult {
    if (this.decided === "none") return { decision: "none" };
    if (this.decided === "answer") return { decision: "answer", text: delta };
    this.buffer += delta;
    const head = this.buffer.trimStart();
    if (head.length === 0) return { decision: "pending" };
    if (head.startsWith("NONE")) {
      this.decided = "none";
      return { decision: "none" };
    }
    if ("NONE".startsWith(head)) return { decision: "pending" };
    this.decided = "answer";
    return { decision: "answer", text: head };
  }

  /** At the end of the stream: true when the reply was only part of "NONE" or empty. */
  isNoneAtEnd(): boolean {
    return this.decided !== "answer";
  }
}
