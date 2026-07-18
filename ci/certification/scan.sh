#!/usr/bin/env bash
# =============================================================================
# ServiceNow scoped-app certification scanner
# -----------------------------------------------------------------------------
# Text-scans exported scoped-app artifacts (*.xml / *.js) for the automatable
# rules in ci/certification/CHECKLIST.md and writes:
#   - cert-report.txt   human-readable, grouped by BLOCKER / advisory
#   - cert-junit.xml     JUnit report (BLOCKER = failure, advisory = passed)
#
# Usage:
#   ci/certification/scan.sh [--mode blocking|advisory|all] [--diff BASE_SHA] [paths...]
#
# Exit code:
#   blocking / all  -> number of BLOCKER violations (0 = clean; used by CI to fail)
#   advisory        -> always 0
#
# Heuristic: a grep hit means "review", not certain defect. Metadata rules
# (ACL coverage, Coalesce, homepage Order, "Run as", mobile menus, install log)
# are NOT covered here - use an ATF suite / Platform-IQ scan for those.
# =============================================================================
set -u

MODE="all"
DIFF_BASE=""
PATHS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)  MODE="${2:-all}"; shift 2 ;;
    --diff)  DIFF_BASE="${2:-}"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

REPORT="cert-report.txt"
JUNIT="cert-junit.xml"
: > "$REPORT"
blockers=0
advisories=0
tc_xml=""

# --- Resolve the file list ---------------------------------------------------
if [ "${#PATHS[@]}" -gt 0 ]; then
  FILES=$(printf '%s\n' "${PATHS[@]}")
elif [ -n "$DIFF_BASE" ]; then
  FILES=$(git diff --name-only "$DIFF_BASE"...HEAD -- '*.xml' '*.js' 2>/dev/null || true)
elif git rev-parse --git-dir >/dev/null 2>&1; then
  FILES=$(git ls-files -- '*.xml' '*.js' 2>/dev/null || true)
fi
[ -z "${FILES:-}" ] && FILES=$(find . -type f \( -name '*.xml' -o -name '*.js' \) 2>/dev/null || true)

n_files=$(printf '%s' "$FILES" | grep -c . || true)
echo "Scanning ${n_files} file(s) [mode=${MODE}] ..."

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

# record <BLOCKER|advisory> <rule-id> <message> <hits-text>
record() {
  local sev="$1" rule="$2" msg="$3" hits="$4"
  local ehits; ehits=$(printf '%s' "$hits" | esc)
  if [ "$sev" = "BLOCKER" ]; then
    blockers=$((blockers + 1))
    printf '  [BLOCKER %s] %s\n' "$rule" "$msg" >> "$REPORT"
    printf '%s\n' "$hits" | sed 's/^/      /' >> "$REPORT"
    tc_xml="${tc_xml}<testcase classname=\"BLOCKER\" name=\"$(printf '%s %s' "$rule" "$msg" | esc)\"><failure>${ehits}</failure></testcase>"
  else
    advisories=$((advisories + 1))
    printf '  [advisory %s] %s\n' "$rule" "$msg" >> "$REPORT"
    printf '%s\n' "$hits" | sed 's/^/      /' >> "$REPORT"
    # advisory -> passed testcase carrying the detail as system-out (never fails the build)
    tc_xml="${tc_xml}<testcase classname=\"advisory\" name=\"$(printf '%s %s' "$rule" "$msg" | esc)\"><system-out>${ehits}</system-out></testcase>"
  fi
}

# grep_check <BLOCKER|advisory> <rule> <msg> <regex>
grep_check() {
  local sev="$1" rule="$2" msg="$3" re="$4" hits
  hits=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -REnI "$re" 2>/dev/null | head -50 || true)
  [ -n "$hits" ] && record "$sev" "$rule" "$msg" "$hits"
}

run_blocking=true; run_advisory=true
[ "$MODE" = "advisory" ] && run_blocking=false
[ "$MODE" = "blocking" ] && run_advisory=false

# ---------------- BLOCKING (Tier 1/2 + recursive BR + tabnabbing) ------------
if $run_blocking; then
  grep_check BLOCKER 1.7 "Possible hard-coded secret (token/password/api_key/credential)" \
        '(password|passwd|pwd|api[_-]?key|apikey|secret|token|credential)["'"'"' ]*[:=]'
  grep_check BLOCKER 2.5 "Dynamic addEncodedQuery() (encoded-query injection)" \
        'addEncodedQuery\(\s*[^"'"'"')]'
  grep_check BLOCKER 2.8 "eval() in script (code injection)" \
        '[^A-Za-z_]eval\s*\('
  grep_check BLOCKER 2.7 "CORS rule with wildcard origin" \
        '<origin>\s*\*\s*</origin>'

  for f in $FILES; do
    [ -f "$f" ] || continue
    if grep -qE '\.getRefRecord\s*\(\)' "$f" 2>/dev/null && ! grep -qE 'isValidRecord\s*\(\)' "$f" 2>/dev/null; then
      record BLOCKER 4.1 "getRefRecord() without isValidRecord() guard" \
             "$(grep -nE '\.getRefRecord\s*\(\)' "$f" | head -20 | sed "s#^#$f:#")"
    fi
    if grep -qiE '<when>[^<]*before' "$f" 2>/dev/null && grep -qE 'current\.(update|insert)\s*\(' "$f" 2>/dev/null; then
      record BLOCKER 1.5 "update()/insert() inside a before business rule (recursion)" \
             "$(grep -nE 'current\.(update|insert)\s*\(' "$f" | head -20 | sed "s#^#$f:#")"
    fi
    if grep -qiE '<client_callable>\s*true' "$f" 2>/dev/null && ! grep -qE 'client_callable_script_include' "$f" 2>/dev/null; then
      record BLOCKER 1.2 "Client-callable Script Include (verify execute ACL exists)" "$f"
    fi
    if grep -qE 'target="_blank"' "$f" 2>/dev/null && ! grep -qE 'rel="[^"]*noopener' "$f" 2>/dev/null; then
      record BLOCKER 7.4 "External link target=_blank without rel=noopener (tabnabbing)" \
             "$(grep -nE 'target="_blank"' "$f" | head -20 | sed "s#^#$f:#")"
    fi
  done
fi

# ---------------- ADVISORY (Tier 3/4) ----------------------------------------
if $run_advisory; then
  grep_check advisory 4.3 "console.log() in shipped code (use jslog())" 'console\.log\s*\('
  grep_check advisory 3.1 "getRowCount() for counting (use GlideAggregate)" '\.getRowCount\s*\(\)'
  grep_check advisory 3.2 "Dot-walking to .sys_id (use getValue())" '\.[A-Za-z_][A-Za-z0-9_]*\.sys_id\b'
  grep_check advisory 3.3 "REST/SOAPMessageV2 present - verify executeAsync() not execute()" 'new sn_ws\.(REST|SOAP)MessageV2'
  grep_check advisory 4.4 "Bare 'var gr =' GlideRecord (name uniquely / wrap in function)" 'var[[:space:]]+gr[[:space:]]*='
  grep_check advisory 4.5 "Hard-coded http(s) URL in script (use gs.getProperty())" 'https?://[^"'"'"' <)]+'
fi

# ---------------- JUnit + summary --------------------------------------------
total=$((blockers + advisories))
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo "<testsuites><testsuite name=\"ServiceNow Certification Gate\" tests=\"${total}\" failures=\"${blockers}\">"
  printf '%s' "$tc_xml"
  echo "</testsuite></testsuites>"
} > "$JUNIT"

echo "============================================================"
echo "Certification gate: ${blockers} blocker(s), ${advisories} advisory(ies)."
echo "============================================================"
cat "$REPORT" 2>/dev/null || true
echo ""
echo "Reference: ci/certification/CHECKLIST.md"

if [ "$MODE" = "advisory" ]; then
  exit 0
fi
exit "$blockers"
