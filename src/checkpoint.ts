import fs from "node:fs";

/** File checkpoints: before every write/edit we snapshot the prior content, keyed by the user turn. */
export interface Snapshot { turn: number; file: string; existed: boolean; content: string }
export class Checkpoints {
  snaps: Snapshot[] = [];
  constructor(init?: Snapshot[]) { if (init) this.snaps = init; }
  record(turn: number, file: string) {
    if (this.snaps.some((s) => s.turn === turn && s.file === file)) return; // first snapshot per turn wins
    const existed = fs.existsSync(file);
    this.snaps.push({ turn, file, existed, content: existed ? fs.readFileSync(file, "utf8") : "" });
  }
  turns(): number[] { return Array.from(new Set(this.snaps.map((s) => s.turn))).sort((a, b) => a - b); }
  /** Restore every file to the state it had before `turn` started. Returns restored files. */
  rewind(turn: number): string[] {
    const later = this.snaps.filter((s) => s.turn >= turn);
    const first = new Map<string, Snapshot>();
    for (const s of later) if (!first.has(s.file)) first.set(s.file, s);
    for (const s of first.values()) { if (s.existed) fs.writeFileSync(s.file, s.content); else try { fs.unlinkSync(s.file); } catch {} }
    this.snaps = this.snaps.filter((s) => s.turn < turn);
    return [...first.keys()];
  }
}
