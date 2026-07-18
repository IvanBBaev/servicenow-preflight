# ServiceNow Scoped-App Certification — Pre-Commit / Pre-Submission Checklist

> **Purpose.** This is an actionable gate distilled from the findings that
> ServiceNow scoped-app certification raises again and again. Run it **before you
> commit / before you submit an app to certification**. If all boxes are ticked,
> you will have pre-empted the overwhelming majority of those findings.
>
> **Audience.** Written to be self-contained for **any developer, reviewer, or AI
> model** — every rule states _what_ to check, _why_, _how to detect it_
> (including a grep/regex pattern for automation), and a **❌ wrong / ✅ right**
> code example. No prior ServiceNow knowledge assumed.

---

## How to use this checklist

**Manual review (per artifact you touched):** walk the tiers top-to-bottom. Tier 1
and Tier 2 are **blocking** — never commit with an unresolved box there. Tiers 3–7
should be resolved or explicitly justified.

**Automated (recommended):** wire the patterns in
[§9 Automated detection](#9-automated-detection--grep-patterns--pre-commit-hook)
into a Git `pre-commit` hook or CI job so the systemic issues fail the build
locally, long before certification sees them.

**Legend:** each rule shows `[severity · seen in N/19 releases]`. Higher release
spread = more systemic = higher priority to automate.
`❌` = pattern that fails certification. `✅` = compliant pattern.

**Decision rule for every box:** _Fixed_ ✔, or _Justified_ (record the reason in
your review-comments column), or **do not commit**.

---

## Tier 1 — BLOCKERS (Critical / High — must be clear before commit)

These map to the findings ServiceNow rates Critical/High and raises **every**
release. Do not commit a Tier-1 violation without an explicit, written waiver.

### 1.1 Every custom table has CRUD ACLs bound to roles `[High · 16/19]`

- **Rule:** every custom (`x_acme_*`) table must have Create/Read/Write/Delete ACLs,
  each bound to a real role — never role-less, never `public`/`nobody`.
- **Why:** no ACL = deny by default _or_ (worse) a role-less ACL = open to any user.
- **Detect:** list `sys_security_acl` for the app; assert 4 operations × each table,
  each with at least one role. Flag any ACL whose role list is empty or contains
  `public`/`nobody`.
- ❌ Table shipped with **no** ACLs, or `Read` ACL with **Requires role: (empty)**.
- ✅ `x_acme_asset` has Create/Read/Write/Delete ACLs, each requiring e.g.
  `x_acme.user` / `x_acme.admin`.

### 1.2 Client-callable Script Includes are ACL-protected `[High · 18/19]` — _one of the most systemic findings_

- **Rule:** any Script Include with **Client callable = true** must have a
  `client_callable_script_include` ACL (operation `execute`) with roles.
- **Why:** client-callable = reachable from the browser via GlideAjax; without the
  execute ACL, **any logged-in user can run it**.
- **Detect:** `sys_script_include` where `client_callable=true`; cross-check for a
  matching `client_callable_script_include` ACL.
- ❌ `client_callable=true`, no execute ACL.
- ✅ `client_callable=true` **and** an `execute` ACL requiring the app role.

### 1.3 Scripted REST resources require Authentication + `REST_Endpoint` ACLs `[High · 14/19]` — _one of the most common security findings_

- **Rule:** every Scripted REST resource has the **Authentication** checkbox on and
  a `REST_Endpoint` ACL with roles. No anonymous endpoints.
- **Why:** unauthenticated/role-less REST = external data access.
- **Detect:** `sys_ws_operation` / `sys_ws_definition`; assert `enforce_acl`/auth and
  a matching `REST_Endpoint` ACL.
- ❌ Scripted REST resource with Authentication **unchecked**.
- ✅ Authentication checked + `REST_Endpoint` ACL (role-gated).

### 1.4 No `script`-type columns exposed to non-admins `[Critical · 9/19]`

- **Rule:** a field of dictionary **type = `script`** (or `script_plain`) must be
  restricted to admins via a field-level ACL.
- **Why:** script fields execute server-side code — a privilege-escalation / RCE
  vector if any user can write them.
- **Detect:** `sys_dictionary` where `internal_type IN (script, script_plain,
script_server)`; verify a write ACL limited to admin.
- ❌ `script`-type field on a user-writable table with no admin-only ACL.
- ✅ Same field with a write ACL requiring `admin` (or an app-admin role).

### 1.5 No recursive `before` business rules `[Critical · 9/19]`

- **Rule:** a `before` business rule must **not** call `current.update()` (and must
  not `current.insert()` — use an `after` rule to insert).
- **Why:** re-saving `current` inside a `before` rule recurses and degrades/hangs.
- **Detect:** `sys_script` where `when=before` and script matches
  `current\.(update|insert)\s*\(`.
- ❌
  ```javascript
  // before BR
  (function (current) {
    current.projected_cost = current.estimate * 1.1;
    current.update(); // ❌ recursion in a before rule
  })(current);
  ```
- ✅
  ```javascript
  // before BR — just set the field; the platform persists it
  (function (current) {
    current.projected_cost = current.estimate * 1.1; // ✅ no update()
  })(current);
  // If you must re-save elsewhere, do it in an AFTER rule and/or use setWorkflow(false).
  ```

### 1.6 No ACLs shipped onto out-of-scope / OOB tables `[High · 7/19]`

- **Rule:** the app must not create ACLs or roles on tables outside its own scope
  (global/OOB).
- **Why:** shipping ACLs onto shared tables can silently widen access on the
  customer instance.
- **Detect:** app-scoped `sys_security_acl` whose `name` targets a non-`x_acme_*`
  table.
- ✅ Keep all ACLs inside the app scope.

### 1.7 No hard-coded secrets in artifacts `[High · 3/19]`

- **Rule:** no tokens, passwords, API keys or credentials packaged in field values
  or scripts.
- **Why:** shipped secrets leak to every customer instance.
- **Detect:** scan artifact source/values for `password|pwd|token|api[_-]?key|
secret|credential\s*[:=]`.
- ✅ Store secrets in Credentials / connection records, not in the app payload.

---

## Tier 2 — SECURITY (High / Medium — resolve or justify)

### 2.1 UI Actions are gated by a condition and/or Required Roles `[High · 10/19]`

- **Rule:** no UI Action with an empty condition **and** no Required Roles.
- **Detect:** `sys_ui_action` where `condition` is empty and `roles`/`action_roles`
  is empty.
- ❌ "Approve" button with no condition and no roles → anyone can click it.
- ✅ Add `Required Roles` and/or a `condition` guarding visibility/execution.

### 2.2 UI Pages have read ACLs `[High · 13/19]`

- **Rule:** custom UI Pages are protected by an ACL on the endpoint (URI without
  `.do`) for read.
- **Detect:** `sys_ui_page`; verify a matching read ACL.

### 2.3 Prefer `GlideRecordSecure` in user-facing server code `[Medium · 7/19]`

- **Rule:** in code that runs on behalf of a user (widgets, scripted REST, UI-page
  processing), use `GlideRecordSecure` so ACLs are enforced.
- **Why:** plain `GlideRecord` **bypasses ACLs**.
- ❌ `var gr = new GlideRecord('x_acme_asset');` in a Service Portal widget.
- ✅ `var gr = new GlideRecordSecure('x_acme_asset');`

### 2.4 Escape all Jelly output (no XSS) `[Medium · 8/19]`

- **Rule:** dynamic values in Jelly/UI-Page HTML must be HTML/JS-escaped.
- **Detect:** UI page/macro source containing `$[...]` (unescaped) where `${...}` /
  proper escaping is required for user-influenced data.
- ❌ `<div>$[jvar_user_input]</div>` (unescaped).
- ✅ `<div>${jvar_user_input}</div>` / apply `GlideStringUtil` escaping.

### 2.5 No user input concatenated into `addEncodedQuery()` `[Medium · 2/19, injection]`

- **Rule:** never build an encoded query from user-controllable input.
- **Why:** encoded-query injection lets a user bypass ACLs and read other data.
- **Detect:** `addEncodedQuery\(` whose argument is not a string literal.
- ❌ `gr.addEncodedQuery('nameLIKE' + userInput);`
- ✅ `gr.addQuery('name', 'CONTAINS', userInput);` (parameterised)

### 2.6 Service Portal widgets & pages have roles `[Medium · 7/19]`

- **Rule:** widgets/pages carry appropriate roles unless deliberately public.
- **Detect:** `sp_widget` / `sp_page` with empty roles.

### 2.7 CORS rules name an exact origin (no wildcard) `[High · 3/19]`

- **Rule:** `sys_cors_rule` origin must be a fully-qualified domain, never `*`.
- ❌ Origin `*`. ✅ Origin `https://app.customer.example.com`.

### 2.8 No client-side `eval()`; validate `GlideScopedEvaluator` sources `[High/Med · 5/19]`

- **Rule:** don't use `eval()` in client scripts; if using `GlideScopedEvaluator`,
  ensure scripts come from trusted stored records, never string-concatenated.
- **Detect:** `[^A-Za-z_]eval\s*\(` in client scripts.

### 2.9 External scripts/stylesheets use SRI hashes `[· 2/19]`

- **Rule:** third-party `<script>`/`<link>` include an `integrity=` (SRI) hash.

---

## Tier 3 — PERFORMANCE (resolve or justify)

### 3.1 Never count rows with `getRowCount()` on GlideRecord `[Medium · 14/19]`

- **Rule:** use `GlideAggregate` (DB-side COUNT), a counter variable, or
  `hasNext()` — not `GlideRecord.getRowCount()` for counting.
- **Why:** `getRowCount()` fetches every matching row then counts; it doesn't scale.
- ❌
  ```javascript
  var gr = new GlideRecord("x_acme_work_order");
  gr.addQuery("state", "open");
  gr.query();
  var count = gr.getRowCount(); // ❌ loads all rows
  ```
- ✅
  ```javascript
  var ga = new GlideAggregate("x_acme_work_order");
  ga.addQuery("state", "open");
  ga.addAggregate("COUNT");
  ga.query();
  var count = ga.next() ? parseInt(ga.getAggregate("COUNT"), 10) : 0; // ✅
  ```

### 3.2 Don't dot-walk to `.sys_id` `[Low · 15/19]`

- **Rule:** read a reference's id with `getValue('field')`, not `field.sys_id`.
- **Why:** dot-walking to `.sys_id` triggers an extra DB read to load the record.
- ❌ `var id = current.caller_id.sys_id;`
- ✅ `var id = current.getValue('caller_id');`

### 3.3 Outbound REST/SOAP in BR/UI Action is asynchronous `[Medium · 8/19]`

- **Rule:** use `executeAsync()` (not `execute()`) for `RESTMessageV2`/
  `SOAPMessageV2` inside business rules and UI actions.
- ❌ `var r = new sn_ws.RESTMessageV2(...); var resp = r.execute();`
- ✅ `var resp = r.executeAsync();` (or move the call to an async/scheduled context)

### 3.4 Bound every XML/loop parse `[High · 4/19]`

- **Rule:** loops parsing external payloads must cap iterations; for responses
  > 10 MB use Data Stream actions.
- **Why:** an unbounded `while` over a huge XML payload can hang the instance.

### 3.5 No dynamic JEXL in `<g:evaluate>` `[· 2/19]`

- **Rule:** prefix Jelly evaluate expressions with `jelly.` to avoid re-parsing;
  don't build dynamic JEXL.

---

## Tier 4 — BEST PRACTICE / CODING (resolve or justify)

### 4.1 Guard `getRefRecord()` with `isValidRecord()` `[Medium · 13/19]` — _one of the highest-volume findings_

- **Rule:** after `getRefRecord()`, check `isValidRecord()` before using the result
  (an empty reference returns an **empty, non-null** GlideRecord).
- **Detect:** every `\.getRefRecord\(\)` should have an `isValidRecord()` guard
  nearby. (Automating this precheck also lets you refute the frequent false
  positives certification raises here.)
- ❌
  ```javascript
  var gr = current.candidate_project.getRefRecord();
  var cost = gr.getValue("amount"); // ❌ gr may be an empty record
  ```
- ✅
  ```javascript
  var gr = current.candidate_project.getRefRecord();
  if (gr.isValidRecord()) {
    // ✅ guard
    var cost = gr.getValue("amount");
  }
  ```

### 4.2 Wrap `GlideRecord.get()` in `if()` `[Medium · 15/19]`

- **Rule:** always test the boolean return of `get()`.
- **Why:** if `get()` fails, the record is empty; a following `update()` can create
  a junk record.
- ❌
  ```javascript
  var gr = new GlideRecord("incident");
  gr.get("invalid_sys_id");
  gr.short_description = "x";
  gr.update(); // ❌ creates/edits the wrong record
  ```
- ✅
  ```javascript
  var gr = new GlideRecord("incident");
  if (gr.get(sysId)) {
    // ✅
    gr.short_description = "x";
    gr.update();
  }
  ```

### 4.3 Use `jslog()` not `console.log()` `[Low · 13/19]`

- **Rule:** no `console.log()` in shipped client code; use `jslog()` (admin-gated).
- **Detect:** `console\.log\s*\(`.
- ❌ `console.log('debug', data);` ✅ `jslog('debug ' + JSON.stringify(data));`

### 4.4 Wrap scripts in a function; never name a GlideRecord `gr` globally `[BP · 4/19]`

- **Rule:** wrap script bodies in a function and use unique, descriptive variable
  names (not a bare global `gr`) to avoid clobbering.
- ❌ top-level `var gr = new GlideRecord(...)` in multiple rules on one table.
- ✅ `(function(){ var assetGr = new GlideRecord('x_acme_asset'); ... })();`

### 4.5 No hard-coded URLs/constants `[Medium · 9/19]`

- **Rule:** read URLs/environment values from properties via `gs.getProperty()`.
- **Detect:** `https?://` inside `sys_script*` script fields.
- ❌ `var url = 'https://api.example.com/v1';`
- ✅ `var url = gs.getProperty('x_acme.api_base_url');`

### 4.6 Client scripts guard with `isLoading` / use conditions `[Low · 11/19]`

- **Rule:** `onChange` scripts start with the `isLoading` guard (and set a Condition
  where possible).
- ✅ `function onChange(control, oldV, newV, isLoading){ if (isLoading) return; ... }`

### 4.7 Prefer `g_scratchpad`/`GlideAjax` over `g_form.getReference()` `[Low · 9/19]`

- **Rule:** don't pull whole records to the client with `getReference()`.

### 4.8 Prefer UI Policy over Client Script for field state `[Low · 4/19]`

- **Rule:** use a UI Policy to make fields mandatory/read-only/visible when no
  scripting is needed.

### 4.9 Don't create artifacts on OOB tables `[Low · 9/19]`

- **Rule:** don't add business rules/fields that change OOB table behaviour.

### 4.10 Remove empty/commented Fix Scripts & duplicate-named Script Includes `[· 5–8/19]`

- **Rule:** delete Fix Scripts that contain only comments; avoid Script Includes
  with duplicate names.

---

## Tier 5 — USABILITY / UX (resolve or justify)

### 5.1 Remove mobile Application Menus & Modules from non-mobile apps `[Low · 17/19]` — _one of the highest-volume usability findings_

- **Rule:** if the app isn't a mobile/touch app, deactivate/remove
  `sys_ui_application` (mobile app menu) and its `sys_ui_module` records.
- **Detect:** presence of `sys_ui_application` + `sys_ui_module` in a desktop-only app.

### 5.2 Transform Maps have a Coalesce and safe choice actions `[High/Med · 6–10/19]`

- **Rule:** every Transform Map sets a **Coalesce** on its unique key(s); reference/
  choice field maps use `ignore`/`reject` (not `create`) unless intended.
- **Why:** no coalesce → duplicate target records; `create` choice action → stray
  records in other tables.

### 5.3 Reports use "Visible to = Everyone" + Roles `[Medium · 6/19]`

- **Rule:** report sharing set to `Everyone`, restricted by **Roles** — never `Me`
  or specific `Groups/Users` (those reference dev-instance records).

### 5.4 Homepages have Order > 3000 and read roles `[Medium · 9/19]`

- **Rule:** every homepage sets `Order > 3000` and a read role, so it can't override
  the customer's default homepage.

### 5.5 Modules have roles `[Medium · 6/19]`

- **Rule:** navigator modules carry roles so they don't show for everyone.

---

## Tier 6 — PACKAGING & PRE-PUBLISH (release gate)

### 6.1 All tables namespaced `[High · 8/19]`

- **Rule:** every custom table name is prefixed with the app namespace
  (`x_acme_*`); otherwise uninstall breaks. Update all references if renaming.

### 6.2 Scheduled Jobs have empty "Run as" `[Low · 12/19]`

- **Rule:** leave `run_as` empty (runs as `system`) so it doesn't reference a
  non-existent user on the customer instance.
- **Detect:** `sysauto_script` with a non-empty `run_as`.

### 6.3 No invalid table references / dangling dependencies `[Low · 4/19]`

- **Rule:** Transform Maps/UI Actions/Workflows reference tables that exist and are
  in the app dependency graph.

### 6.4 Workflow approvers are valid/active; verify Flow Designer version `[· 2–3/19]`

- **Rule:** workflows reference active approvers; flows are built on the **lowest
  supported** platform release (Flow Designer isn't backward-compatible).

### 6.5 Installation log is clean `[Usability→Critical · 11/19]`

- **Rule:** install the app on a clean instance and confirm `sys_plugin_log` has no
  errors; resolve dependency/order issues.

### 6.6 Deleted/withdrawn artifacts are actually gone

- **Rule:** demo data, inactive examples, dead metadata and mis-packaged
  mobile-platform records are removed (these fill the "Deleted Files" lists).

---

## Tier 7 — 2026 NEW REQUIREMENTS (required for current certification)

### 7.1 App Privacy Policy module `[Security]`

- **Rule:** ship a module/UI page stating what data is collected and whether it's
  transferred/processed/stored outside ServiceNow. (TPP KB0030801.)

### 7.2 Contact Support module `[Best Practice]`

- **Rule:** include an in-app module with support-coverage details.

### 7.3 Accessibility statement `[Accessibility]`

- **Rule:** document the accessibility standards the solution follows (in-app and in
  the design doc).

### 7.4 Tabnabbing protection on external links `[Security]`

- **Rule:** every external anchor uses `rel="noopener noreferrer nofollow"`.
- **Detect:** `target="_blank"` without a matching `rel=` containing `noopener`.

### 7.5 App-specific ACLs over "Scripted REST External Default" `[Security]`

- **Rule:** don't rely on the default external ACL; ship app-specific REST ACLs.

---

## 9. Automated detection — grep patterns & pre-commit hook

These patterns catch the highest-spread issues in exported artifact source (XML/JS).
They are **heuristics** — a hit means _review_, not necessarily _defect_ — but they
reproduce most of what certification's probes flag. Tune paths to your export
layout (e.g. `sys_script`, `sys_script_include`, `sys_script_client`, `sys_ui_*`).

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit  (chmod +x)
# Certification pre-commit gate. Exit non-zero to block the commit.
set -u
staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(xml|js)$' || true)
[ -z "$staged" ] && exit 0

fail=0
flag() { echo "  [$1] $2"; fail=1; }

for f in $staged; do
  # --- Tier 1/2 security ---
  grep -nE 'console\.log\s*\(' "$f"            && flag "4.3 console.log"      "$f"
  grep -nE '\.getRowCount\s*\(\)' "$f"         && flag "3.1 getRowCount"      "$f"
  grep -nE '\.[A-Za-z_][A-Za-z0-9_]*\.sys_id\b' "$f" && flag "3.2 dot-walk .sys_id" "$f"
  grep -nE '[^A-Za-z_]eval\s*\(' "$f"          && flag "2.8 eval()"          "$f"
  grep -nE 'addEncodedQuery\s*\(\s*[^"'"'"')]'  "$f" && flag "2.5 dynamic addEncodedQuery" "$f"
  grep -nE 'https?://' "$f" | grep -qv 'docs.servicenow\|developer.servicenow' \
        && grep -nE 'https?://' "$f" && flag "4.5 hard-coded URL" "$f"
  grep -nE 'new sn_ws\.(REST|SOAP)MessageV2' "$f" | grep -q . \
        && grep -nE '\.execute\s*\(\s*\)' "$f" && flag "3.3 sync .execute() (use executeAsync)" "$f"
  grep -nE 'target="_blank"' "$f" | grep -qv 'noopener' \
        && grep -nE 'target="_blank"' "$f" && flag "7.4 tabnabbing (missing rel=noopener)" "$f"

  # --- Heuristics that need a nearby-guard check ---
  if grep -qE '\.getRefRecord\s*\(\)' "$f" && ! grep -qE 'isValidRecord\s*\(\)' "$f"; then
      flag "4.1 getRefRecord without isValidRecord" "$f"; fi
  if grep -qE '\bwhen\b.*before' "$f" && grep -qE 'current\.(update|insert)\s*\(' "$f"; then
      flag "1.5 update()/insert() in before rule" "$f"; fi
  if grep -qE 'client_callable.*true|true.*client_callable' "$f" \
       && ! grep -qE 'client_callable_script_include' "$f"; then
      flag "1.2 client-callable SI (verify execute ACL)" "$f"; fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Certification pre-commit gate: issues found (see ci/certification/CHECKLIST.md)."
  echo "Fix, or re-run with:  git commit --no-verify  (records a waiver)."
  exit 1
fi
exit 0
```

> **Note.** ACL coverage (rules 1.1–1.4, 2.1–2.2, 2.6), Coalesce, homepage Order,
> "Run as", mobile menus and install-log checks require **metadata queries**, not
> text grep. Implement those as an **ATF suite** or a Platform-IQ-style scan that
> reads `sys_security_acl`, `sys_dictionary`, `sys_ui_action`, `sys_ui_page`,
> `sp_widget`, `sysauto_script`, `sys_ui_application`, etc.

---

## 10. Quick reference — the full rule table

| #    | Rule                                   | Category      | Sev      | Spread  |  Auto?   |
| ---- | -------------------------------------- | ------------- | -------- | :-----: | :------: |
| 1.1  | Table CRUD ACLs with roles             | Security      | High     |  16/19  | metadata |
| 1.2  | Client-callable SI has execute ACL     | Security      | High     |  18/19  | metadata |
| 1.3  | Scripted REST auth + REST_Endpoint ACL | Security      | High     |  14/19  | metadata |
| 1.4  | No exposed `script`-type columns       | Security      | Critical |  9/19   | metadata |
| 1.5  | No recursive `before` BR update/insert | Performance   | Critical |  9/19   |   grep   |
| 1.6  | No ACLs on out-of-scope tables         | Security      | High     |  7/19   | metadata |
| 1.7  | No hard-coded secrets                  | Security      | High     |  3/19   |   grep   |
| 2.1  | UI Action condition/roles              | Security      | High     |  10/19  | metadata |
| 2.2  | UI Page read ACL                       | Security      | High     |  13/19  | metadata |
| 2.3  | GlideRecordSecure in user code         | Security      | Med      |  7/19   |   grep   |
| 2.4  | Escape Jelly output (XSS)              | Security      | Med      |  8/19   |   grep   |
| 2.5  | No dynamic addEncodedQuery             | Security      | Med      |  2/19   |   grep   |
| 2.6  | Widget/page roles                      | Security      | Med      |  7/19   | metadata |
| 2.7  | CORS exact origin                      | Security      | High     |  3/19   | metadata |
| 2.8  | No client eval()                       | Security      | High     |  5/19   |   grep   |
| 2.9  | SRI hashes                             | Security      | Low      |  2/19   |   grep   |
| 3.1  | No getRowCount() counting              | Performance   | Med      |  14/19  |   grep   |
| 3.2  | No dot-walk to .sys_id                 | Performance   | Low      |  15/19  |   grep   |
| 3.3  | Async outbound calls                   | Performance   | Med      |  8/19   |   grep   |
| 3.4  | Bounded XML/loop parsing               | Performance   | High     |  4/19   |  review  |
| 3.5  | No dynamic JEXL                        | Performance   | Low      |  2/19   |   grep   |
| 4.1  | getRefRecord + isValidRecord           | Best Practice | Med      |  13/19  |   grep   |
| 4.2  | get() wrapped in if()                  | Best Practice | Med      |  15/19  |   grep   |
| 4.3  | jslog() not console.log()              | Best Practice | Low      |  13/19  |   grep   |
| 4.4  | Function-wrap; no global `gr`          | Best Practice | Low      |  4/19   |   grep   |
| 4.5  | No hard-coded URLs                     | Best Practice | Med      |  9/19   |   grep   |
| 4.6  | isLoading guard                        | Best Practice | Low      |  11/19  |   grep   |
| 4.7  | No g_form.getReference()               | Best Practice | Low      |  9/19   |   grep   |
| 4.8  | UI Policy over Client Script           | Best Practice | Low      |  4/19   |  review  |
| 4.9  | No artifacts on OOB tables             | Best Practice | Low      |  9/19   | metadata |
| 4.10 | Remove empty Fix Scripts / dup SIs     | Best Practice | Low      | 5–8/19  | metadata |
| 5.1  | Remove mobile menus/modules            | Usability     | Low      |  17/19  | metadata |
| 5.2  | Transform Coalesce + safe choice       | Usability     | High     | 6–10/19 | metadata |
| 5.3  | Reports Everyone + Roles               | Usability     | Med      |  6/19   | metadata |
| 5.4  | Homepage Order>3000 + roles            | Usability     | Med      |  9/19   | metadata |
| 5.5  | Module roles                           | Usability     | Med      |  6/19   | metadata |
| 6.1  | Namespaced tables                      | Install       | High     |  8/19   | metadata |
| 6.2  | Scheduled Job Run-as empty             | Install       | Low      |  12/19  | metadata |
| 6.3  | No invalid table refs                  | Install       | Low      |  4/19   | metadata |
| 6.4  | Valid approvers / Flow version         | Best Practice | Med      | 2–3/19  |  review  |
| 6.5  | Clean install log                      | Usability     | High     |  11/19  |  review  |
| 6.6  | Deleted artifacts removed              | Packaging     | —        |    —    |  review  |
| 7.1  | App Privacy Policy module              | Security      | —        |  2026   |  review  |
| 7.2  | Contact Support module                 | Best Practice | —        |  2026   |  review  |
| 7.3  | Accessibility statement                | Accessibility | —        |  2026   |  review  |
| 7.4  | Tabnabbing rel=noopener                | Security      | —        |  2026   |   grep   |
| 7.5  | App-specific REST ACLs                 | Security      | —        |  2026   | metadata |

---

## 11. Sign-off

```
Release / app version : ____________________________
Reviewer              : ____________________________
Date                  : ____________________________

Tier 1 (blockers)     : [ ] all clear / [ ] waivers attached
Tier 2 (security)     : [ ] all clear / [ ] justified
Tier 3 (performance)  : [ ] all clear / [ ] justified
Tier 4 (best practice): [ ] all clear / [ ] justified
Tier 5 (usability)    : [ ] all clear / [ ] justified
Tier 6 (packaging)    : [ ] all clear / [ ] justified
Tier 7 (2026 reqs)    : [ ] all present

Automated gate (pre-commit / CI) : [ ] green
Notes / waivers:
____________________________________________________
```

> Keep the completed sign-off with the release. It becomes your evidence trail and,
> over time, lets you track the **recurrence rate** — the single best measure of
> whether these fixes are actually sticking release-over-release.
