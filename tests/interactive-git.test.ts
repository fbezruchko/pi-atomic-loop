import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBatchFacts,
  countDrift,
  ensureInteractiveBaseline,
  getHeadSha,
  type GitRunner,
} from "../src/interactive-git.ts";

function fakeRunner(
  script: Record<
    string,
    { code: number; stdout: string; stderr: string }
  >,
): GitRunner {
  return async (args) =>
    script[args.join(" ")] ?? {
      code: 1,
      stdout: "",
      stderr: "unexpected",
    };
}

test("getHeadSha returns undefined without HEAD", async () => {
  const run = fakeRunner({
    "rev-parse HEAD": { code: 128, stdout: "", stderr: "no head" },
  });
  assert.equal(await getHeadSha(run), undefined);
});

test("ensureInteractiveBaseline creates an empty commit when HEAD is missing", async () => {
  const calls: string[] = [];

  const run: GitRunner = async (args) => {
    calls.push(args.join(" "));

    if (
      args.join(" ") ===
      "commit --allow-empty -m loop: interactive baseline"
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args.join(" ") === "rev-parse HEAD") {
      return calls.filter((c) => c === "rev-parse HEAD").length === 1
        ? { code: 128, stdout: "", stderr: "no head" }
        : { code: 0, stdout: "abc123\n", stderr: "" };
    }

    return { code: 1, stdout: "", stderr: "unexpected" };
  };

  const result = await ensureInteractiveBaseline(run);

  assert.equal(result.ok, true);
  assert.equal(result.sha, "abc123");
  assert.ok(
    calls.includes(
      "commit --allow-empty -m loop: interactive baseline",
    ),
  );
});

test("collectBatchFacts marks untracked files and returns paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-facts-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const baseline = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "a.txt"), "base\nchanged\n");
  writeFileSync(join(dir, "new.txt"), "untracked\n");

  const facts = await collectBatchFacts(async (args) => {
    try {
      return {
        code: 0,
        stdout: execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
        }),
        stderr: "",
      };
    } catch (error) {
      const e = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };

      return {
        code: e.status ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }, baseline);

  assert.equal(facts.ok, true);
  assert.match(facts.diff, /new\.txt/);
  assert.deepEqual(facts.paths.sort(), ["a.txt", "new.txt"]);
});

test("countDrift counts intermediate commits", async () => {
  const run = fakeRunner({
    "rev-list --count base..HEAD": {
      code: 0,
      stdout: "2\n",
      stderr: "",
    },
  });

  assert.equal(await countDrift(run, "base"), 2);
});

test("interactive baseline never swallows uncommitted work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-baseline-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "dirty.txt"), "work in progress\n");

  const run: GitRunner = async (args) => {
    try {
      return {
        code: 0,
        stdout: execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
        }),
        stderr: "",
      };
    } catch (error) {
      const e = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };

      return {
        code: e.status ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  };

  const baseline = await ensureInteractiveBaseline(run);
  assert.equal(baseline.ok, true);

  const committed = git([
    "show",
    "--name-only",
    "--pretty=format:",
    baseline.sha,
  ]).trim();

  assert.equal(committed, "");

  const facts = await collectBatchFacts(run, baseline.sha);
  assert.equal(facts.ok, true);
  assert.match(facts.diff, /dirty\.txt/);
});
