export type Tier = 1 | 2 | 3;
export type QType = "fix" | "complete" | "write";

export interface BankQuestion {
  id: string;
  tier: Tier;
  type: QType;
  title: string;
  prompt: string;
  starterCode: string;
  sampleInput: string;
  sampleOutput: string;
  hiddenInputs: string[];
  hiddenOutputs: string[];
  solution: string;
}

// What a student may see (no hidden inputs, outputs, or solution)
export interface PublicQuestion {
  id: string;
  tier: Tier;
  type: QType;
  title: string;
  prompt: string;
  starterCode: string;
  sampleInput: string;
  sampleOutput: string;
}

export const TYPE_LABEL: Record<QType, string> = {
  fix: "Fix the bug",
  complete: "Complete the code",
  write: "Write the program",
};

export const TIER_LABEL = ["", "Easy", "Medium", "Hard"];

// Ignore trailing spaces and blank lines at the end
export const normalizeOutput = (s: string) =>
  s
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();