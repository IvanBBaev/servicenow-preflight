/* ============================================================================
   servicenow-preflight — split-flap departure board + interactions
   Vanilla JS, no dependencies. Ported from the design-handoff prototype.

   Motion (per handoff): a realistic Solari roll — each tile cycles through a
   run of random characters (drawn from a roll TEMPLATE) with a short rotateX
   flip on every change, then lands on its final letter. The roll is guaranteed
   to settle: an `animating` flag + `commitFinals()` snap every tile to its
   `data-final` when timers are cleared, and a safety settle-timeout force-
   commits the finals. Under prefers-reduced-motion the roll is skipped and the
   final text is shown at once.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Roll templates — the character pools a tile cycles through while it rolls.
     Several sets are kept and switched between: each tile draws from a
     different template, and the assignment shifts on every re-run, so the
     characters streaming past visibly change from one flip to the next. */
  var ROLL_TEMPLATES = [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ·-/#*", // full mixed (the classic set)
    "0123456789 ·:/#*-=+", // digits & symbols
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ ·", // letters only
    "#*·-/=<>|+ 0189ABXYZ", // sparse "static" / glitch
    "0123456789ABCDEF ·:#/-", // hex — a sys_id-style code flicker
  ];

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

  // Snap a cell's tiles straight to their finals (used for the static gate
  // numbers, which anchor each row and never roll).
  function showFinals(container) {
    container.querySelectorAll(".flap-tile").forEach(function (t) {
      t.textContent = t.dataset.final || " ";
    });
  }

  function setFinals(container, str) {
    var tiles = container.querySelectorAll(".flap-tile");
    var s = (str || "").toUpperCase();
    tiles.forEach(function (t, i) {
      t.dataset.final = s[i] || " ";
    });
  }

  /* ---- Roll engine ---------------------------------------------------- */
  var timers = [];
  var animating = false;
  var runCounter = 0; // advances each animated run so templates rotate

  function pushTimer(t) {
    timers.push(t);
  }

  // Clear every pending timer/interval. If a roll was mid-flight, snap tiles to
  // their finals so the board can never be left frozen on scrambled characters.
  function clearTimers() {
    timers.forEach(function (t) {
      clearTimeout(t);
      clearInterval(t);
    });
    timers = [];
    if (animating) {
      commitFinals();
      animating = false;
    }
  }

  function commitFinals() {
    var cells = [headlineEl, summaryEl];
    rowEls.forEach(function (re) {
      cells.push(re.name);
      cells.push(re.status);
    });
    cells.forEach(function (c) {
      if (c) showFinals(c);
    });
  }

  // Roll one tile through a run of random chars, then land on its final.
  function flap(container, baseDelay, animate) {
    var tiles = Array.prototype.slice.call(
      container.querySelectorAll(".flap-tile"),
    );
    tiles.forEach(function (t, i) {
      var finalCh = t.dataset.final || " ";
      if (!animate || reduceMotion) {
        t.textContent = finalCh;
        return;
      }
      var pool = ROLL_TEMPLATES[(runCounter + i) % ROLL_TEMPLATES.length];
      var steps = 6 + ((Math.random() * 8) | 0) + Math.floor(i * 0.35);
      var s = 0;
      var start = setTimeout(function () {
        var iv = setInterval(function () {
          s++;
          if (s >= steps) {
            clearInterval(iv);
            timers = timers.filter(function (x) {
              return x !== iv;
            });
            t.textContent = finalCh;
            flipTile(t, true);
          } else {
            t.textContent = pool[(Math.random() * pool.length) | 0];
            flipTile(t, false);
          }
        }, 42);
        pushTimer(iv);
      }, baseDelay + i * 20);
      pushTimer(start);
    });
  }

  // One rotateX flip for a single character change; a longer eased settle when
  // the tile lands on its final letter.
  function flipTile(t, settle) {
    if (reduceMotion || !t.animate) return;
    try {
      t.animate(
        [
          {
            transform: "rotateX(-90deg)",
            filter: "brightness(1.35)",
            offset: 0,
          },
          { transform: "rotateX(0deg)", filter: "brightness(1)", offset: 1 },
        ],
        {
          duration: settle ? 150 : 62,
          easing: settle ? "cubic-bezier(.2,.9,.25,1)" : "linear",
        },
      );
    } catch (e) {
      /* animation unsupported — final char already shown */
    }
  }

  // Lighter flap-fold reveal for larger blocks (timetable rows, detail lines).
  function flipReveal(els, stagger, dur) {
    els.forEach(function (el, i) {
      if (!el || reduceMotion || !el.animate) return;
      try {
        el.style.transformOrigin = "top center";
        el.animate(
          [
            {
              transform: "perspective(600px) rotateX(-58deg)",
              opacity: 0,
              offset: 0,
            },
            {
              transform: "perspective(600px) rotateX(7deg)",
              opacity: 1,
              offset: 0.76,
            },
            {
              transform: "perspective(600px) rotateX(0deg)",
              opacity: 1,
              offset: 1,
            },
          ],
          {
            duration: dur || 300,
            delay: i * (stagger || 45),
            easing: "cubic-bezier(.2,.85,.3,1)",
            fill: "backwards",
          },
        );
      } catch (e) {
        /* animation unsupported — element already visible */
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
      showFinals(gate); // gate numbers are static anchors — never roll
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
    clearTimers();
    if (animate && !reduceMotion) runCounter++;
    animating = !!animate && !reduceMotion;

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

    // Safety net: force every final after the roll should have completed, so a
    // throttled interval (e.g. a backgrounded tab) can never strand the board.
    if (animate && !reduceMotion) {
      var total = 360 + rowEls.length * 130 + 1600;
      pushTimer(
        setTimeout(function () {
          commitFinals();
          animating = false;
        }, total),
      );
    } else {
      animating = false;
    }

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
  var ttButtons = [];
  var ioAttached = false;

  function buildTimetable() {
    if (!ttRows || !ttDetail) return;
    ttRows.innerHTML = "";
    ttButtons = [];
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
        selectGate(i);
      });
      ttRows.appendChild(btn);
      ttButtons.push(btn);
    });
    renderDetail();
    observeTimetable();
  }

  // Reveal the timetable rows with a flap-fold the first time they scroll in.
  function observeTimetable() {
    if (reduceMotion || ioAttached || !("IntersectionObserver" in window))
      return;
    ioAttached = true;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            flipReveal(ttButtons, 70, 320);
            io.disconnect();
          }
        });
      },
      { threshold: 0.18 },
    );
    io.observe(ttRows);
  }

  function selectGate(i) {
    if (i === selected) return;
    selected = i;
    ttButtons.forEach(function (b, idx) {
      b.setAttribute("aria-selected", idx === selected ? "true" : "false");
    });
    renderDetail();
    // Re-fold the detail lines + the freshly-picked row.
    var lines = [
      ttDetail.querySelector(".detail-body .name"),
      ttDetail.querySelector(".detail-body .desc"),
    ].concat(
      Array.prototype.slice.call(
        ttDetail.querySelectorAll(".criteria > .crit"),
      ),
    );
    flipReveal(lines, 55, 300);
    if (ttButtons[selected]) flipReveal([ttButtons[selected]], 0, 260);
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
  buildTimetable();
  renderCli();
  renderKv("[data-envs]", ENVS, "");
  renderKv("[data-errs]", ERRS, "err");
  renderSponsors();
  run(true, true);
})();
