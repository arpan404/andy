const MAX_FILE_LINES = 400;
const MAX_FUNCTION_LINES = 80;

const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const EXCLUDE_SEGMENTS = new Set(["node_modules", ".git", "dist", ".turbo", ".agents"]);

type Violation = {
  path: string;
  message: string;
};

function shouldExclude(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => EXCLUDE_SEGMENTS.has(segment));
}

function isSourceFile(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return false;
  const extension = path.slice(lastDot);
  return INCLUDE_EXTENSIONS.has(extension);
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for await (const entry of new Bun.Glob("*").scan({ cwd: dir, absolute: true })) {
      const fullPath = entry;
      if (shouldExclude(fullPath)) continue;
      const stat = await Bun.file(fullPath).stat();
      if (stat.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (isSourceFile(fullPath)) files.push(fullPath);
    }
  }

  await walk(root);
  return files;
}

function countFunctionSizeViolations(path: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split("\n");

  let inFunction = false;
  let functionStartLine = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!inFunction) {
      const maybeFunction =
        /\bfunction\b/.test(trimmed) ||
        /=>\s*{/.test(trimmed) ||
        /\b(?:if|for|while|switch|catch)\b[^{]*{/.test(trimmed) === false;
      const opensBlock = trimmed.includes("{");
      if (maybeFunction && opensBlock && (trimmed.includes("function") || trimmed.includes("=>"))) {
        inFunction = true;
        functionStartLine = i + 1;
        braceDepth = 0;
      }
    }

    if (inFunction) {
      for (const ch of line) {
        if (ch === "{") braceDepth += 1;
        if (ch === "}") braceDepth -= 1;
      }

      if (braceDepth <= 0) {
        const functionEndLine = i + 1;
        const length = functionEndLine - functionStartLine + 1;
        if (length > MAX_FUNCTION_LINES) {
          violations.push({
            path,
            message: `function too large (${length} lines > ${MAX_FUNCTION_LINES}) around line ${functionStartLine}`,
          });
        }
        inFunction = false;
        functionStartLine = 0;
        braceDepth = 0;
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const files = await collectFiles(root);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const text = await Bun.file(filePath).text();
    const lineCount = text === "" ? 0 : text.split("\n").length;
    const relativePath = filePath.replace(`${root}/`, "");

    if (lineCount > MAX_FILE_LINES) {
      violations.push({
        path: relativePath,
        message: `file too large (${lineCount} lines > ${MAX_FILE_LINES})`,
      });
    }

    violations.push(...countFunctionSizeViolations(relativePath, text));
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`LIMIT ${violation.path}: ${violation.message}`);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("LIMIT failed:", error);
  process.exit(1);
});
