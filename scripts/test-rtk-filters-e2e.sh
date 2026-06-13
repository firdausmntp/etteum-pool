#!/usr/bin/env bash
# E2E test for RTK shape filters — fire real HTTP requests with content
# specifically shaped to trigger each new filter (git-status, read-numbered,
# grep, dedup-log) plus regression on git-diff and tree.

set -e
BASE="http://localhost:1930"
DB="data/poolprox3.db"
KEY="sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF"

START_ID=$(sqlite3 "$DB" "SELECT COALESCE(MAX(id),0) FROM request_logs;")
echo "Starting from request id > $START_ID"
echo

post() {
  local label="$1"; local payload="$2"
  echo "→ $label"
  curl -s -X POST "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $KEY" \
    -H "anthropic-version: 2023-06-01" \
    -d "$payload" -o /dev/null -w "  HTTP %{http_code}\n" || true
  sleep 0.4
}

# Helper: build a 7-message request where messages[2] is a tool_result with given content.
# (RTK only compresses indices < len-keepN*2; with keepN=2, len=7, indices 0,1,2 are eligible.)
build() {
  local content="$1"
  python3 -c "
import json
print(json.dumps({
  'model': 'claude-sonnet-4-5',
  'max_tokens': 50,
  'messages': [
    {'role': 'user', 'content': 'do'},
    {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'u1', 'name': 'Bash', 'input': {}}]},
    {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'u1', 'content': '''$content'''}]},
    {'role': 'assistant', 'content': 'done'},
    {'role': 'user', 'content': 'next'},
    {'role': 'assistant', 'content': 'k'},
    {'role': 'user', 'content': 'y'},
  ],
}))
"
}

# === git-status (large enough to exceed 4KB threshold for lossy filter) ===
GS=$(python3 -c "
lines = ['## main']
for i in range(120): lines.append(' M src/very/long/path/to/some/deeply/nested/file_'+str(i)+'.ts')
for i in range(80): lines.append('?? new_subdir/temp_file_with_long_name_'+str(i)+'.txt')
lines.append('UU src/conflict.ts')
print('\n'.join(lines).replace(chr(10),'\\\\n'))
")
post "T1 git-status" "$(build "$GS")"

# === read-numbered ===
RN=$(python3 -c "
lines = [str(i+1) + '→  some content for line ' + str(i+1) for i in range(600)]
print('\n'.join(lines).replace(chr(10),'\\\\n'))
")
post "T2 read-numbered" "$(build "$RN")"

# === grep (>4KB so lossy filter triggers) ===
GR=$(python3 -c "
lines = [\"Result of search in 'src' (total 5 files):\"]
for i in range(1, 80): lines.append('src/very/long/path/foo.ts:'+str(i)+':matched line content here '+str(i))
for i in range(1, 40): lines.append('src/very/long/path/bar.ts:'+str(i)+':hit content of line '+str(i))
for i in range(1, 20): lines.append('src/baz.ts:'+str(i)+':single match content '+str(i))
print('\n'.join(lines).replace(chr(10),'\\\\n'))
")
post "T3 grep" "$(build "$GR")"

# === dedup-log ===
DL=$(python3 -c "
lines = ['Building...']
lines += ['  resolving deps'] * 40
lines += ['Compiling foo.ts']
lines += ['  caching'] * 15
lines += ['Done.']
print('\n'.join(lines).replace(chr(10),'\\\\n'))
")
post "T4 dedup-log" "$(build "$DL")"

# === git-diff (regression — bigger to trigger lossy threshold) ===
GD=$(python3 -c "
hunk = '\n'.join(['+    longer line of content here number ' + str(i) for i in range(120)])
print(('diff --git a/foo.ts b/foo.ts\\\\nindex 1234567..abcdefg 100644\\\\n--- a/foo.ts\\\\n+++ b/foo.ts\\\\n@@ -1,120 +1,120 @@\\\\n' + hunk + '\\\\n@@ -200,80 +200,80 @@\\\\n' + hunk).replace(chr(10),'\\\\n'))
")
post "T5 git-diff (regression)" "$(build "$GD")"

# === tree (regression) ===
TR=$(python3 -c "
lines = ['.', '├── a', '├── b', '├── c', '├── d', '├── e']
for i in range(300): lines.append('│   ├── some_deeply_nested_file_with_long_name_' + str(i) + '.ts')
print('\n'.join(lines).replace(chr(10),'\\\\n'))
")
post "T6 tree (regression)" "$(build "$TR")"

echo
echo "Wait 2s for log flush..."
sleep 2

echo
echo "=== Per-filter savings (id > $START_ID) ==="
sqlite3 -header -column "$DB" "
SELECT id,
  json_extract(compression_stats, '\$.byTechnique.rtk') AS rtk_total,
  json_extract(compression_stats, '\$.rtkFilters')      AS filters,
  json_extract(compression_stats, '\$.saved')           AS saved
FROM request_logs WHERE id > $START_ID ORDER BY id;
"
