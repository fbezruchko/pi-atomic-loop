export type LoopMode =
  | "supervised"
  | "autonomous";

export interface StartArgs {
  description: string;
  criteria: string;
  maxIterations: number;
  untilDone: boolean;
  mode: LoopMode;
  delaySeconds: number;
  checkCommand: string;
  checkTimeoutSeconds: number;
  model: string;
  rescueModel: string;
  goalFile: string;
}

function extractCheckCommand(text: string): {
  rest: string;
  checkCommand: string;
} {
  const match = text.match(
    /--check(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/,
  );

  if (
    !match ||
    match.index === undefined
  ) {
    return {
      rest: text,
      checkCommand: "",
    };
  }

  const checkCommand = (
    match[1] ??
    match[2] ??
    match[3] ??
    ""
  ).trim();

  const rest =
    `${text.slice(0, match.index)} ${text.slice(
      match.index + match[0].length,
    )}`.trim();

  return {
    rest,
    checkCommand,
  };
}

function parseMode(
  value: string,
): LoopMode | undefined {
  const normalized =
    value.toLowerCase();

  if (
    normalized ===
    "supervised"
  ) {
    return "supervised";
  }

  if (
    normalized ===
    "autonomous"
  ) {
    return "autonomous";
  }

  return undefined;
}

export function parseStartArgs(
  args: string,
): StartArgs {
  const {
    rest,
    checkCommand,
  } = extractCheckCommand(
    args.trim(),
  );

  const tokens =
    rest.split(/\s+/);

  let maxIterations = 0;
  let untilDone = false;
  let mode: LoopMode =
    "supervised";
  let delaySeconds = 0;
  let checkTimeoutSeconds = 120;
  let model = "";
  let rescueModel = "";
  let goalFile = "";

  const kept: string[] = [];

  for (
    let i = 0;
    i < tokens.length;
    i++
  ) {
    const token =
      tokens[i];

    if (
      token === "--max" &&
      tokens[i + 1]
    ) {
      maxIterations =
        Math.max(
          0,
          Number.parseInt(
            tokens[++i],
            10,
          ) || 0,
        );
      continue;
    }

    if (
      token.startsWith(
        "--max=",
      )
    ) {
      maxIterations =
        Math.max(
          0,
          Number.parseInt(
            token.slice(
              "--max=".length,
            ),
            10,
          ) || 0,
        );
      continue;
    }

    if (
      token === "--delay" &&
      tokens[i + 1]
    ) {
      delaySeconds =
        Math.max(
          0,
          Number.parseInt(
            tokens[++i],
            10,
          ) || 0,
        );
      continue;
    }

    if (
      token.startsWith(
        "--delay=",
      )
    ) {
      delaySeconds =
        Math.max(
          0,
          Number.parseInt(
            token.slice(
              "--delay=".length,
            ),
            10,
          ) || 0,
        );
      continue;
    }

    if (
      token ===
        "--rescue-model" &&
      tokens[i + 1]
    ) {
      rescueModel =
        tokens[++i];
      continue;
    }

    if (
      token.startsWith(
        "--rescue-model=",
      )
    ) {
      rescueModel =
        token.slice(
          "--rescue-model=".length,
        );
      continue;
    }

    if (
      token === "--model" &&
      tokens[i + 1]
    ) {
      model =
        tokens[++i];
      continue;
    }

    if (
      token.startsWith(
        "--model=",
      )
    ) {
      model =
        token.slice(
          "--model=".length,
        );
      continue;
    }

    if (
      (
        token === "--file" ||
        token === "--goal-file"
      ) &&
      tokens[i + 1]
    ) {
      goalFile =
        tokens[++i];
      continue;
    }

    if (
      token.startsWith(
        "--file=",
      )
    ) {
      goalFile =
        token.slice(
          "--file=".length,
        );
      continue;
    }

    if (
      token ===
        "--check-timeout" &&
      tokens[i + 1]
    ) {
      checkTimeoutSeconds =
        Math.max(
          1,
          Number.parseInt(
            tokens[++i],
            10,
          ) || 120,
        );
      continue;
    }

    if (
      token.startsWith(
        "--check-timeout=",
      )
    ) {
      checkTimeoutSeconds =
        Math.max(
          1,
          Number.parseInt(
            token.slice(
              "--check-timeout=".length,
            ),
            10,
          ) || 120,
        );
      continue;
    }

    if (
      token ===
      "--until-done"
    ) {
      untilDone = true;
      mode = "autonomous";
      continue;
    }

    if (
      token === "--mode" &&
      tokens[i + 1]
    ) {
      const parsedMode =
        parseMode(
          tokens[++i],
        );

      if (parsedMode) {
        mode = parsedMode;
        untilDone =
          parsedMode ===
          "autonomous";
      }

      continue;
    }

    if (
      token.startsWith(
        "--mode=",
      )
    ) {
      const parsedMode =
        parseMode(
          token.slice(
            "--mode=".length,
          ),
        );

      if (parsedMode) {
        mode = parsedMode;
        untilDone =
          parsedMode ===
          "autonomous";
      }

      continue;
    }

    kept.push(token);
  }

  const text =
    kept.join(" ").trim();

  const match = text.match(
    /^(.*?)(?:\bDone when\b\s*:?\s*)(.*)$/i,
  );

  const description =
    (
      match?.[1] ??
      text
    )
      .trim()
      .replace(
        /[.\s]+$/,
        "",
      );

  const criteria =
    (
      match?.[2] ??
      ""
    ).trim();

  return {
    description,
    criteria,
    maxIterations,
    untilDone:
      mode === "autonomous",
    mode:
      mode === "autonomous"
        ? "autonomous"
        : "supervised",
    delaySeconds,
    checkCommand,
    checkTimeoutSeconds,
    model,
    rescueModel,
    goalFile,
  };
}
