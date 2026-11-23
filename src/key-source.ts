/**
 * Where an operator key comes from: a file path (local use: the file stays outside the
 * repository, mode 600) or a variable holding the content itself (hosted use, e.g.
 * Railway, where no file can be uploaded). The content is a SECRET: never logged
 * (see `describeConfig` and `redactSecrets` in config.ts).
 */
export type KeySource =
  | { from: "file"; path: string }
  | { from: "env"; /** The variable's name (shown in logs and errors; its value never is). */ variable: string; json: string };

/** Safe to log: the path of a file source, only the variable name of an env source. */
export function describeKeySource(s: KeySource | null): string | null {
  if (!s) return null;
  return s.from === "file" ? `file ${s.path}` : `env ${s.variable} (set, not shown)`;
}
