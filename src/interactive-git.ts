export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  timeout?: number,
) => Promise<GitResult>;

function snippet(
  value: string,
  max = 300,
): string {
  const text = value.trim();

  return text.length > max
    ? `${text.slice(0, max)}…`
    : text;
}

export async function getHeadSha(
  run: GitRunner,
): Promise<string | undefined> {
  const result = await run([
    "rev-parse",
    "HEAD",
  ]);

  if (result.code !== 0) {
    return undefined;
  }

  const sha = result.stdout.trim();

  return sha || undefined;
}

export async function ensureInteractiveBaseline(
  run: GitRunner,
): Promise<{
  ok: boolean;
  sha: string;
  reason: string;
}> {
  const existing = await getHeadSha(run);

  if (existing) {
    return {
      ok: true,
      sha: existing,
      reason: "HEAD present",
    };
  }

  const commit = await run([
    "commit",
    "--allow-empty",
    "-m",
    "loop: interactive baseline",
  ]);

  if (commit.code !== 0) {
    return {
      ok: false,
      sha: "",
      reason: `baseline commit failed: ${snippet(
        commit.stderr || commit.stdout,
      )}`,
    };
  }

  const created = await getHeadSha(run);

  if (!created) {
    return {
      ok: false,
      sha: "",
      reason: "no HEAD after baseline commit",
    };
  }

  return {
    ok: true,
    sha: created,
    reason: "baseline commit created",
  };
}

function parseStatusPaths(
  statusText: string,
): string[] {
  return statusText
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (line.length < 4) {
        return "";
      }

      const raw = line.slice(3).trim();

      const path = raw.includes(" -> ")
        ? raw.split(" -> ").at(-1) ?? raw
        : raw;

      return path.startsWith('"') && path.endsWith('"')
        ? path.slice(1, -1)
        : path;
    })
    .filter(Boolean);
}

export interface BatchFacts {
  ok: boolean;
  diff: string;
  statusText: string;
  stat: string;
  paths: string[];
  reason: string;
}

export async function collectBatchFacts(
  run: GitRunner,
  baselineSha: string,
): Promise<BatchFacts> {
  if (!baselineSha) {
    return {
      ok: false,
      diff: "",
      statusText: "",
      stat: "",
      paths: [],
      reason: "missing interactive baseline",
    };
  }

  /** Intent-to-add makes untracked files visible in the diff. */
  const add = await run([
    "add",
    "-N",
    ".",
  ]);

  if (add.code !== 0) {
    return {
      ok: false,
      diff: "",
      statusText: "",
      stat: "",
      paths: [],
      reason: `git add -N failed: ${snippet(
        add.stderr || add.stdout,
      )}`,
    };
  }

  const diff = await run([
    "diff",
    "--no-color",
    baselineSha,
  ]);

  if (diff.code !== 0) {
    return {
      ok: false,
      diff: "",
      statusText: "",
      stat: "",
      paths: [],
      reason: `git diff failed: ${snippet(
        diff.stderr || diff.stdout,
      )}`,
    };
  }

  const stat = await run([
    "diff",
    "--stat",
    baselineSha,
  ]);

  if (stat.code !== 0) {
    return {
      ok: false,
      diff: "",
      statusText: "",
      stat: "",
      paths: [],
      reason: `git diff --stat failed: ${snippet(
        stat.stderr || stat.stdout,
      )}`,
    };
  }

  const status = await run([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  if (status.code !== 0) {
    return {
      ok: false,
      diff: "",
      statusText: "",
      stat: "",
      paths: [],
      reason: `git status failed: ${snippet(
        status.stderr || status.stdout,
      )}`,
    };
  }

  const statusText = status.stdout.replace(/\n+$/, "");

  return {
    ok: true,
    diff: diff.stdout,
    statusText,
    stat: stat.stdout.trim(),
    paths: parseStatusPaths(statusText),
    reason: "",
  };
}

export async function countDrift(
  run: GitRunner,
  baselineSha: string,
): Promise<number> {
  if (!baselineSha) {
    return 0;
  }

  const result = await run([
    "rev-list",
    "--count",
    `${baselineSha}..HEAD`,
  ]);

  if (result.code !== 0) {
    return 0;
  }

  return Number.parseInt(result.stdout.trim(), 10) || 0;
}
