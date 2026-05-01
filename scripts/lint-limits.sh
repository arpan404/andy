#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MAX_FILE_LINES=450
MAX_FUNCTION_LINES=90
FAILED=0

check_file_lines() {
  local file="$1"
  local lines
  lines="$(wc -l < "$file" | tr -d ' ')"
  if [ "$lines" -gt "$MAX_FILE_LINES" ]; then
    echo "File too large (${lines} lines > ${MAX_FILE_LINES}): $file" >&2
    FAILED=1
  fi
}

check_function_lines() {
  local file="$1"
  awk -v max_lines="$MAX_FUNCTION_LINES" -v file="$file" '
    BEGIN {
      in_func = 0
      brace_depth = 0
      func_start = 0
      signature = ""
    }
    {
      line = $0
      if (in_func == 0 && line ~ /^[[:space:]]*(public |private |internal |fileprivate |open )?(static )?(override )?(mutating )?func[[:space:]]+/) {
        in_func = 1
        func_start = NR
        signature = line
        gsub(/^[[:space:]]+/, "", signature)
      }

      if (in_func == 1) {
        opens = gsub(/\{/, "{", line)
        closes = gsub(/\}/, "}", line)
        brace_depth += opens - closes

        if (brace_depth == 0 && index(line, "{") > 0) {
          # one-line empty body case, end immediately
          func_len = NR - func_start + 1
          if (func_len > max_lines) {
            printf("Function too large (%d lines > %d) in %s:%d\n  %s\n", func_len, max_lines, file, func_start, signature) > "/dev/stderr"
            exit_code = 1
          }
          in_func = 0
          signature = ""
          func_start = 0
        } else if (brace_depth <= 0 && func_start > 0 && NR > func_start) {
          func_len = NR - func_start + 1
          if (func_len > max_lines) {
            printf("Function too large (%d lines > %d) in %s:%d\n  %s\n", func_len, max_lines, file, func_start, signature) > "/dev/stderr"
            exit_code = 1
          }
          in_func = 0
          brace_depth = 0
          signature = ""
          func_start = 0
        }
      }
    }
    END {
      if (exit_code == 1) {
        exit 1
      }
    }
  ' "$file" || FAILED=1
}

while IFS= read -r file; do
  check_file_lines "$file"
  check_function_lines "$file"
done < <(find Sources Tests Apps/Desktop/Sources -name '*.swift' -type f | sort)

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
