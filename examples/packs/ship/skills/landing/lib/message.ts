export const ALLOWED_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "style",
  "perf",
  "build",
  "ci",
] as const;

export const TRAILER_LABELS = [
  "Constraint",
  "Rejected",
  "Directive",
  "Confidence",
  "Scope-risk",
  "Not-tested",
  "Ticket",
] as const;

export const REQUIRED_TRAILER_LABELS = ["Confidence", "Scope-risk"] as const;

const TRAILER_VALUES: Record<string, readonly string[]> = {
  Confidence: ["high", "medium", "low"],
  "Scope-risk": ["narrow", "moderate", "broad"],
};

const MAX_DESCRIPTION_LENGTH = 72;

const HEADER_PATTERN = /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?: (?<description>.*)$/;

const TRAILER_PATTERN = /^(?<label>[A-Z][A-Za-z-]*): (?<value>.+)$/;

function startsWithKnownTrailer(line: string): boolean {
  return TRAILER_LABELS.some((label) => line.startsWith(`${label}:`));
}

// One known trailer makes the block trailers, so a malformed line in it errors instead of passing as prose.
function trailerBlockLines(lines: string[]): string[] {
  const lastBlankIndex = lines.lastIndexOf("");
  if (lastBlankIndex === -1) {
    return [];
  }
  const block = lines.slice(lastBlankIndex + 1);
  if (!block.some(startsWithKnownTrailer)) {
    return [];
  }
  return block;
}

function validateHeader(header: string, errors: string[]): void {
  const match = HEADER_PATTERN.exec(header);
  if (!match?.groups) {
    errors.push(
      "header must be `<type>(<scope>): <description>` or `<type>: <description>`, " +
        `got ${JSON.stringify(header)}`,
    );
    return;
  }
  const { type, description } = match.groups;
  if (!(ALLOWED_TYPES as readonly string[]).includes(type ?? "")) {
    errors.push(`type must be one of ${ALLOWED_TYPES.join(", ")}, got ${JSON.stringify(type)}`);
  }
  const text = description ?? "";
  if (text.trim() === "") {
    errors.push("description must not be empty");
  }
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
  }
  if (text.endsWith(".")) {
    errors.push("description must not end with a trailing period");
  }
}

function isChoreHeader(header: string): boolean {
  return HEADER_PATTERN.exec(header)?.groups?.type === "chore";
}

function validateTrailers(block: string[], errors: string[]): void {
  if (block.length === 0) {
    return;
  }
  const values = new Map<string, string>();
  for (const line of block) {
    const match = TRAILER_PATTERN.exec(line);
    if (!match?.groups) {
      errors.push(`trailer line must be \`<Label>: <value>\`, got ${JSON.stringify(line)}`);
      continue;
    }
    const label = match.groups.label ?? "";
    const value = match.groups.value ?? "";
    if (!(TRAILER_LABELS as readonly string[]).includes(label)) {
      errors.push(
        `unknown trailer ${JSON.stringify(label)}; allowed trailers are ${TRAILER_LABELS.join(", ")}`,
      );
      continue;
    }
    values.set(label, value.trim());
  }
  for (const label of REQUIRED_TRAILER_LABELS) {
    if (!values.has(label)) {
      errors.push(`${label} trailer is required when the message carries trailers`);
    }
  }
  for (const [label, allowed] of Object.entries(TRAILER_VALUES)) {
    const value = values.get(label);
    if (value !== undefined && !allowed.includes(value)) {
      errors.push(`${label} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    }
  }
}

export function validateMessage(message: string): string[] {
  const errors: string[] = [];
  const lines = message.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");

  if (message.trim() === "") {
    return ["message must not be empty"];
  }

  validateHeader(lines[0] ?? "", errors);

  const isHeaderOnly = lines.slice(1).every((line) => line.trim() === "");
  if (isHeaderOnly && !isChoreHeader(lines[0] ?? "")) {
    errors.push("a header-only message is allowed only for chore; add a body saying why, or the trailer block");
  }

  if (lines.length > 1 && lines[1] !== "") {
    errors.push("the line after the header must be blank");
  }

  validateTrailers(trailerBlockLines(lines), errors);

  return errors;
}

export function normalizeMessage(message: string): string {
  return `${message.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
}
