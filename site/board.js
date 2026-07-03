/* ============================================================================
   servicenow-preflight — split-flap departure board + interactions
   Vanilla JS, no dependencies. Ported from the design-handoff prototype.

   Key rule (per handoff): every tile shows its FINAL character immediately, so
   the board is always readable even if a flip is interrupted. The flip is pure
   decoration and is skipped under prefers-reduced-motion.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Content model: the seven checks -------------------------------- */
  var CHECKS = [
    {
      code: "01",
      name: "instance-url-configured",
      tag: "ALWAYS",
      desc: "An instance URL is present and well-formed, and preferably uses https.",
      fail: "No URL provided, or the value is not a valid URL.",
      warn: "A valid URL that is not https.",
      pass: "A well-formed https URL.",
    },
    {
      code: "02",
      name: "connectivity-auth",
      tag: "ALWAYS",
      desc: "The instance is reachable and the supplied credentials authenticate against it.",
      fail: "HTTP 401 / missing credentials, unreachable host, or an unexpected non-2xx response.",
      warn: "No credentials configured, or a 403 (authenticated but lacking rights).",
      pass: "Reachable and successfully authenticated.",
    },
    {
      code: "03",
      name: "update-set-state",
      tag: "updateSetId",
      desc: "The target update set is complete, carries changes, and is free of merge collisions.",
      fail: "Missing, still in progress, complete but with zero changes, or the read failed.",
      warn: "No id set, an unrecognised state, unreachable, or merge / collision flags.",
      pass: "Complete and carries at least one change.",
    },
    {
      code: "04",
      name: "atf-run",
      tag: "atfSuites",
      desc: "The configured ATF test suites run green — no failing or errored tests.",
      fail: "Any test is red — the message carries the failing assertion text.",
      warn: "No suite configured, a run still pending, or a transient unreachable error.",
      pass: "Every configured suite settled green.",
    },
    {
      code: "05",
      name: "scoped-app-deps",
      tag: "requiredApps",
      desc: "Required scoped apps and plugins are installed, active, and meet any minVersion.",
      fail: "A required app is missing, inactive, or below its declared minVersion.",
      warn: "None declared, entries malformed, or a version could not be read.",
      pass: "Every dependency present, active, and up to date.",
    },
    {
      code: "06",
      name: "i18n-completeness",
      tag: "scope · languages",
      desc: "Every configured language has full translation coverage for the target scope.",
      fail: "One or more languages have gaps, or the instance returned an error.",
      warn: "No scope / languages set, a language with no baseline, or unreachable.",
      pass: "Every required language is fully covered.",
    },
    {
      code: "07",
      name: "acl-role-sanity",
      tag: "scope",
      desc: "No wide-open mutating ACLs, and no ACLs that reference non-existent roles.",
      fail: "A mutating ACL is public-write, or references a role that does not exist.",
      warn: "No scope, a public-read ACL, inactive shipped ACLs, or unreadable tables.",
      pass: "Every ACL is gated and every referenced role resolves.",
    },
  ];

  var SCENARIOS = {
    default: ["pass", "pass", "warn", "warn", "warn", "warn", "warn"],
    configured: ["pass", "pass", "pass", "pass", "pass", "pass", "pass"],
    failure: ["pass", "pass", "fail", "fail", "warn", "warn", "fail"],
  };

  function word(st) {
    return st === "pass" ? "CLEARED" : st === "warn" ? "HOLD" : "DENIED";
  }
  function col(st) {
    return st === "pass"
      ? "var(--ok)"
      : st === "warn"
        ? "var(--amber)"
        : "var(--red)";
  }

  /* ---- Flap tile helpers ---------------------------------------------- */
  function tile(finalCh) {
    var s = document.createElement("span");
    s.className = "flap-tile";
    s.textContent = " ";
    s.dataset.final = finalCh;
    return s;
  }

  // Build a fixed-width run of `len` tiles into `container`, optional color.
  function fillTiles(container, len, color) {
    container.innerHTML = "";
    for (var i = 0; i < len; i++) {
      var t = tile(" ");
      if (color) t.style.color = color;
      container.appendChild(t);
    }
  }

  // A standalone cell (its own inline-flex wrapper) of `len` tiles.
  function cell(str, len, color) {
    var wrap = document.createElement("span");
    wrap.className = "flap-cell";
    var s = (str || "").toUpperCase().padEnd(len, " ").slice(0, len);
    for (var i = 0; i < len; i++) wrap.appendChild(tile(s[i]));
    if (color) {
      wrap.querySelectorAll(".flap-tile").forEach(function (t) {
        t.style.color = color;
      });
    }
    return wrap;
  }

  function setFinals(container, str) {
    var tiles = container.querySelectorAll(".flap-tile");
    var s = (str || "").toUpperCase();
    tiles.forEach(function (t, i) {
      t.dataset.final = s[i] || " ";
    });
  }

  function flap(container, baseDelay, animate) {
    var tiles = Array.prototype.slice.call(
      container.querySelectorAll(".flap-tile"),
    );
    tiles.forEach(function (t, i) {
      var finalCh = t.dataset.final || " ";
      // Set final char immediately — board stays correct if the flip is cut off.
      t.textContent = finalCh;
      if (!animate || reduceMotion || !t.animate) return;
      try {
        t.animate(
          [
            { transform: "rotateX(-88deg)", opacity: 0.2, offset: 0 },
            { transform: "rotateX(10deg)", opacity: 1, offset: 0.72 },
            { transform: "rotateX(0deg)", opacity: 1, offset: 1 },
          ],
          {
            duration: 240,
            delay: baseDelay + i * 24,
            easing: "cubic-bezier(.2,.85,.3,1)",
            fill: "backwards",
          },
        );
      } catch (e) {
        /* animation unsupported — final char already shown */
      }
    });
  }

  /* ---- Board state + elements ----------------------------------------- */
  var scenario = "default";
  var headlineEl = document.querySelector("[data-headline]");
  var boardEl = document.querySelector("[data-board]");
  var summaryEl = document.querySelector("[data-summary]");
  var exitEl = document.querySelector("[data-exit]");
  var rowEls = [];

  function buildBoard() {
    if (!boardEl) return;
    boardEl.innerHTML = "";
    rowEls = [];
    CHECKS.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "row";
      var gate = cell(c.code, 2, "var(--amber)");
      var name = cell(c.name, 23);
      var spacer = document.createElement("span");
      spacer.className = "spacer";
      var status = cell("HOLD", 7, "var(--amber)");
      row.appendChild(gate);
      row.appendChild(name);
      row.appendChild(spacer);
      row.appendChild(status);
      boardEl.appendChild(row);
      rowEls.push({ name: name, status: status });
    });
    if (headlineEl) fillTiles(headlineEl, 18, "var(--amber)");
    if (summaryEl) fillTiles(summaryEl, 30, "#c9cdd4");
  }

  function run(animate, intro) {
    var sts = SCENARIOS[scenario] || SCENARIOS.default;
    var pass = sts.filter(function (s) {
      return s === "pass";
    }).length;
    var warn = sts.filter(function (s) {
      return s === "warn";
    }).length;
    var fail = sts.filter(function (s) {
      return s === "fail";
    }).length;
    var blocked = fail > 0;

    if (headlineEl)
      setFinals(headlineEl, blocked ? "EXIT 1 — BLOCKED" : "EXIT 0 — CLEARED");
    rowEls.forEach(function (re, i) {
      var st = sts[i];
      setFinals(re.status, word(st));
      re.status.querySelectorAll(".flap-tile").forEach(function (t) {
        t.style.color = col(st);
      });
    });
    if (summaryEl)
      setFinals(
        summaryEl,
        pass + " CLEARED  " + warn + " HOLD  " + fail + " DENIED",
      );

    if (exitEl) {
      exitEl.textContent = "EXIT " + (blocked ? "1" : "0");
      exitEl.style.background = blocked ? "var(--red)" : "var(--ok)";
    }

    if (headlineEl) flap(headlineEl, 60, animate);
    rowEls.forEach(function (re, i) {
      if (intro) flap(re.name, 260 + i * 130, animate);
      flap(re.status, 360 + i * 130, animate);
    });
    if (summaryEl) flap(summaryEl, 360 + rowEls.length * 130, animate);

    applyScenarioButtons();
  }

  function goScenario(sc) {
    scenario = sc;
    run(true, false);
  }

  function applyScenarioButtons() {
    document.querySelectorAll("[data-sc]").forEach(function (b) {
      b.setAttribute(
        "aria-pressed",
        b.getAttribute("data-sc") === scenario ? "true" : "false",
      );
    });
  }

  /* ---- Timetable: rows + gate detail ---------------------------------- */
  var ttRows = document.querySelector("[data-tt-rows]");
  var ttDetail = document.querySelector("[data-tt-detail]");
  var selected = 0;

  function renderTimetable() {
    if (!ttRows || !ttDetail) return;
    ttRows.innerHTML = "";
    CHECKS.forEach(function (c, i) {
      var always = c.tag === "ALWAYS";
      var btn = document.createElement("button");
      btn.className = "tt-row";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === selected ? "true" : "false");
      btn.innerHTML =
        '<span class="gate">' +
        c.code +
        "</span>" +
        '<span class="name">' +
        c.name +
        "</span>" +
        '<span class="remark ' +
        (always ? "remark-boards" : "remark-hold") +
        '">' +
        (always ? "BOARDS" : "ON HOLD") +
        "</span>";
      btn.addEventListener("click", function () {
        selected = i;
        renderTimetable();
      });
      ttRows.appendChild(btn);
    });
    renderDetail();
  }

  function renderDetail() {
    var c = CHECKS[selected];
    var always = c.tag === "ALWAYS";
    ttDetail.innerHTML =
      '<div class="detail-head">' +
      '<span class="gate-label"><span class="lbl">GATE</span><span class="code">' +
      c.code +
      "</span></span>" +
      '<span class="detail-tag" style="border-color:' +
      (always ? "var(--ok)" : "#3a3f48") +
      ";color:" +
      (always ? "var(--ink)" : "#c9cdd4") +
      '">' +
      c.tag +
      "</span>" +
      "</div>" +
      '<div class="detail-body">' +
      '<div class="name">' +
      c.name +
      "</div>" +
      '<p class="desc">' +
      c.desc +
      "</p>" +
      '<div class="criteria">' +
      crit("denied", "DENIED", c.fail) +
      crit("hold", "HOLD", c.warn) +
      crit("cleared", "CLEARED", c.pass) +
      "</div></div>";
  }

  function crit(cls, label, text) {
    return (
      '<div class="crit ' +
      cls +
      '"><span class="tag"><span class="dot"></span>' +
      label +
      '</span><span class="val">' +
      text +
      "</span></div>"
    );
  }

  /* ---- Static reference lists ----------------------------------------- */
  var CLI = [
    { flag: "-i, --instance <url>", desc: "Target ServiceNow instance URL." },
    {
      flag: "--config <path>",
      desc: "Path to a config file (default: auto-discovered).",
    },
    {
      flag: "--only <csv>",
      desc: "Run only these checks (comma-separated names).",
    },
    {
      flag: "--skip <csv>",
      desc: "Skip these checks (comma-separated names).",
    },
    { flag: "--format <fmt>", desc: "pretty (default), json, junit, sarif." },
    { flag: "--json / -h", desc: "Shorthand for --format json / show help." },
  ];
  var ENVS = [
    { k: "SNPF_TOKEN", v: "OAuth bearer token — wins over Basic if set." },
    {
      k: "SNPF_USER + SNPF_PASS",
      v: "Basic-auth username and password (both required).",
    },
    {
      k: "SNPF_INSTANCE",
      v: "Instance URL, used when --instance / config is unset.",
    },
  ];
  var ERRS = [
    { k: "SnAuthError", v: "HTTP 401 / 403, or missing credentials." },
    {
      k: "SnNetworkError",
      v: "DNS / connection failure / timeout — unreachable.",
    },
    {
      k: "SnHttpError",
      v: "Any other non-2xx. Secrets never appear in messages.",
    },
  ];
  var SPONSORS = [
    {
      k: "GitHub Sponsors",
      href: "https://github.com/sponsors/IvanBBaev",
      note: "preferred — no platform fee",
    },
    {
      k: "Ko-fi",
      href: "https://ko-fi.com/ivanbbaev",
      note: "quick one-off; also PayPal",
    },
    {
      k: "Donatree",
      href: "https://donatr.ee/ivanbbaev/",
      note: "no-account donation page",
    },
  ];

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderCli() {
    var el = document.querySelector("[data-cli]");
    if (!el) return;
    el.innerHTML = CLI.map(function (o) {
      return (
        '<div class="flag">' +
        esc(o.flag) +
        '</div><div class="desc">' +
        esc(o.desc) +
        "</div>"
      );
    }).join("");
  }

  function renderKv(sel, list, extraClass) {
    var el = document.querySelector(sel);
    if (!el) return;
    el.innerHTML = list
      .map(function (e) {
        return (
          '<div class="kv ' +
          (extraClass || "") +
          '"><div class="k">' +
          esc(e.k) +
          '</div><div class="v">' +
          esc(e.v) +
          "</div></div>"
        );
      })
      .join("");
  }

  function renderSponsors() {
    var el = document.querySelector("[data-sponsors]");
    if (!el) return;
    el.innerHTML = SPONSORS.map(function (s) {
      return (
        '<a class="sponsor" href="' +
        s.href +
        '" target="_blank" rel="noopener">' +
        '<span class="l"><span class="name">' +
        esc(s.k) +
        '</span><span class="note">' +
        esc(s.note) +
        "</span></span>" +
        '<span class="arrow">↗</span></a>'
      );
    }).join("");
  }

  /* ---- Copy buttons --------------------------------------------------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-copy]");
    if (!b) return;
    var wrap = b.closest("[data-term]");
    var pre = wrap && wrap.querySelector("pre");
    var text = pre ? pre.innerText : "";
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text);
    } catch (err) {
      /* clipboard unavailable */
    }
    var old = b.getAttribute("data-label") || "copy";
    b.textContent = "copied";
    setTimeout(function () {
      b.textContent = old;
    }, 1100);
  });

  /* ---- Wire scenario + re-run buttons --------------------------------- */
  document.querySelectorAll("[data-sc]").forEach(function (b) {
    b.addEventListener("click", function () {
      goScenario(b.getAttribute("data-sc"));
    });
  });
  var rerunBtn = document.querySelector("[data-rerun]");
  if (rerunBtn)
    rerunBtn.addEventListener("click", function () {
      run(true, true);
    });

  /* ---- Init ----------------------------------------------------------- */
  buildBoard();
  renderTimetable();
  renderCli();
  renderKv("[data-envs]", ENVS, "");
  renderKv("[data-errs]", ERRS, "err");
  renderSponsors();
  run(true, true);
})();
