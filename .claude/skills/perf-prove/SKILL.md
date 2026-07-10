---
name: perf-prove
description: "Prove a performance fix with a live before/after A/B: drive the real app with a headless Playwright + CDP script against the pre-fix and post-fix servers, measure retained memory / DOM / interaction latency, and produce a comparison + traces. The escalation path from /perf-review."
user-invocable: true
argument-hint: "[feature under test]"
---

# Performance A/B Profiling — prove it, don't claim it

Prove that a performance fix actually works by measuring the **real running app**, not a benchmark or a unit test. The output is a before→after comparison table + Chrome traces that a skeptic can't wave away.

> This doc is the **method**. Everything feature-specific (what action creates load, which DOM markers to count, which interaction you time) is isolated to **§7 Per-feature customization** and the `CONFIG` block of the script. Fill those in per feature; leave the rest untouched.

---

## 1. When to use this

- You made a change claimed to reduce memory / DOM growth / jank, and need evidence it worked.
- A /perf-review finding is contested and static argument won't settle it.
- The symptom scales with a repeated user action (opening N of something, rendering N rows, N interactions).
- "It feels faster" or "the unit test passes" is not enough — you want a curve.

**Do NOT use this** for pure algorithmic micro-benchmarks (use a bench harness) or for changes with no user-observable runtime surface.

## 2. What it produces

1. A metrics matrix: each metric, at N = 1 / 4 / 8 / 12 / 16 (or whatever load steps fit), **broken → fixed**.
2. Two Chrome traces (one per server) for flame-graph inspection.
3. Optionally a visual artifact (charts) and a PR comment.

The headline is always the same shape: **broken grows with N, fixed stays flat.**

## 3. The core idea: A/B against two live servers

The single most important decision. Measuring only the fixed build gives you "after" numbers with nothing to compare against. To *prove* a fix you need the **before** curve from the same script, same data, same machine.

```
pre-fix commit  ──►  server on :PORT_B (isolated worktree)   ┐
                                                              ├──►  same Playwright script  ──►  compare
post-fix branch ──►  server on :PORT_A (the one you have up) ┘
```

Both servers hit the **same local DB** (Postgres/ClickHouse/Redis are shared across worktrees), so the A/B is on identical data — the only variable is the code.

## 4. Tools you need (and why)

| Tool | Why |
|---|---|
| `playwright` (already a dev dep) | Drives a real headless Chromium. Run the script from **inside** `langwatch/` so `node` resolves `node_modules`. |
| Chromium via `npx playwright install chromium` | The headless *shell* is a separate download from the full browser; installs on first miss. |
| **Chrome DevTools Protocol (CDP)** session | The only way to get real memory metrics: `Performance.getMetrics`, `HeapProfiler.collectGarbage`, `Tracing.*`. Get it with `context.newCDPSession(page)`. |
| `git worktree` | Stand up the pre-fix baseline in isolation without touching your running server. |
| `psql` to the local DB | Discover a project/entity with real data + an existing session to reuse for auth. |
| A forged session cookie | Log in headlessly without a login UI. See §6.3. |

## 5. Procedure

### 5.1 Stand up the pre-fix baseline server

1. Find the commit just before the fix: `git rev-parse <first-fix-commit>^` (or the merge-base with main).
2. Create an isolated worktree at that commit so HMR on your working server is untouched:
   ```bash
   git worktree add <path>/perf-baseline <prefix-commit>
   ```
   The `post-checkout` hook copies `.env` in, so it shares your DB **and** auth secret.
3. `pnpm install --prefer-offline` then `pnpm prisma generate` in the baseline `langwatch/`.
4. Boot it on a second port, skipping services you don't need for the surface under test:
   ```bash
   LANGWATCH_SKIP_NLP=1 LANGWATCH_SKIP_AIGATEWAY=1 PORT=<PORT_B> pnpm dev
   ```
5. Confirm the auth secret and DB URL match your primary server (else a forged cookie won't validate on both):
   ```bash
   grep -E "^NEXTAUTH_SECRET=" <A>/.env | md5   # must equal
   grep -E "^NEXTAUTH_SECRET=" <B>/.env | md5
   ```

### 5.2 Discover a target with real data

Query the local DB for an entity that actually has content to load and an existing session to reuse:

```bash
export PGOPTIONS="--search_path=langwatch_db"
PSQL="postgresql://postgres@localhost:5432/langwatch_db"
psql "$PSQL" -tAc "select email, id from langwatch_db.\"User\" order by \"createdAt\" limit 5;"
# find a project/slug + a live session for one of those users (see §6.3)
```

### 5.3 Write & run the profiling script

Copy the template in §8, fill in the `CONFIG` block (§7), drop it as an **untracked** file inside the running server's `langwatch/` dir (e.g. `.perf-<feature>.mjs`), and run it against each server:

```bash
BASE_URL=http://localhost:<PORT_B> LABEL=broken  <env…> node .perf-<feature>.mjs
BASE_URL=http://localhost:<PORT_A> LABEL=fixed    <env…> node .perf-<feature>.mjs
```

### 5.4 Compare & present

- Emit a `broken → fixed` matrix from the two `report-*.json` files.
- The trace file sizes themselves corroborate (more DOM/work = bigger trace for the same interaction).
- Optionally build a chart artifact and post a PR comment.
- If the fix revealed a **new** anti-pattern not yet in /perf-review's catalog, add it there as a rule.

### 5.5 Clean up (non-negotiable)

- Delete the untracked `.perf-*.mjs` scripts.
- Kill the baseline server **by process group** (`pnpm dev` spawns children that respawn if you kill only the listener):
  ```bash
  pgid=$(ps -Ao pgid,command | grep <baseline-path> | grep -v grep | awk '{print $1}' | sort -u)
  kill -TERM -- -"$pgid"
  ```
- `git worktree remove <path>/perf-baseline --force && git worktree prune`.
- Verify your primary server still responds.

## 6. The gotchas that actually matter

These are the traps that silently make your numbers lie. Getting them right is the whole difference between real evidence and hand-waving.

### 6.1 CDP `Nodes` counts detached-pending-GC nodes — do NOT use it raw
`Performance.getMetrics` → `Nodes` includes nodes that were unmounted but not yet garbage-collected. On a fix that *unmounts* content, this counter stays inflated until GC runs, so **both** broken and fixed look bad and the comparison is muddied. Instead:
- **Force GC before every sample**: `await client.send("HeapProfiler.collectGarbage")` (enable `HeapProfiler` first).
- Measure **live** DOM with `document.querySelectorAll('*').length` in `page.evaluate` — this is attached nodes only, the honest number.

> Real trap hit once: an early run showed "8.9k → 21k nodes" on the *fixed* build and nearly derailed the conclusion. It was pure GC lag; live DOM was flat at ~2k.

### 6.2 Force GC before the heap sample too
Same reason. Retained heap after `collectGarbage()` is the number that means "memory this build actually holds onto." Un-GC'd heap is noise.

### 6.3 Auth: forge the session cookie, don't script the login UI
The app uses BetterAuth with **signed** session cookies, so you can't just inject a raw DB token. Reuse an existing live session:
1. `psql` the `Session` table for a non-expired `sessionToken` for a user with data.
2. The cookie value is `encodeURIComponent(token + "." + base64(HMAC_SHA256(token, secret)))` where `secret` = `NEXTAUTH_SECRET` from `.env`. (Verified against `better-call`'s `serializeSignedCookie`; the HMAC key is the raw secret string.)
3. Compute it in Node (`crypto.createHmac("sha256", secret)`), set it via `context.addCookies([{ name: "better-auth.session_token", value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }])`.
4. Sanity check against `GET /api/auth/get-session` before running the whole script.

Because the cookie is host-scoped for `localhost` (ports don't matter) and both servers share the DB + secret, **one forged cookie authenticates on both servers.**

### 6.4 Make the comparison discriminating, not decorative
The metrics only prove something if the *broken* build actually shows the problem. Before trusting a "fixed = flat" result, confirm the *broken* run shows the growth. If broken and fixed look the same, either the fix does nothing **or your metric doesn't capture the effect** — investigate before concluding.

### 6.5 Settle between load steps
After each load-increasing action, wait for `networkidle` + a fixed delay ≥ any debounce in the feature, so you sample steady state, not mid-transition.

## 7. Per-feature customization — the ONLY parts you change

Everything else in the template is fixed. Swap these four things per feature:

1. **Load action** — the single user action that, repeated, grows the cost. (e.g. clicking a sidebar item to open a tab; adding a row; opening a drawer.) → `openOne(page)` in the template.
2. **Mount markers** — DOM selectors that reveal how much is mounted. Pick the *mechanism* signal that should stay flat if the fix works: count of the heavy per-item subtree, or `[role=tabpanel][hidden]` (mounted-but-hidden), or per-item editor instances. → `domMetrics()` selectors.
3. **Interaction to time** — the operation whose latency the user feels (typing a burst, dragging, a filter apply). Measure wall-clock around it. → the keystroke/interaction block.
4. **Load steps** — `MILESTONES` (1/4/8/12/16 is a good default; use fewer/larger if each step is expensive).

If a metric is 0 or identical on both sides, it's the wrong marker for this feature — pick a different one (§6.4).

## 8. Script template (generic, parameterized)

```js
// .perf-<feature>.mjs — run from inside langwatch/ so `playwright` resolves.
import { chromium } from "playwright";
import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

// ---- CONFIG: fill these per feature (see §7) ----
const CONFIG = {
  path: (project) => `/${project}/<feature-route>`,   // page under test
  // The repeated action that grows cost. Return after it's issued.
  openOne: async (page) => { /* e.g. page.getByText(ITEM,{exact:true}).first().click() */ },
  // DOM markers: keep whatever should stay flat when the fix works.
  domSelectors: (q) => ({
    liveNodes: document.querySelectorAll("*").length,
    // e.g. mountedPanels: q('[role="tabpanel"]'),
    // e.g. hiddenPanels: q('[role="tabpanel"][hidden]'),
  }),
  // Element to exercise for interaction latency (or null to skip).
  interactionTarget: "textarea",
  interactionText: "performance probe 12345",
};
const MILESTONES = (process.env.MILESTONES ?? "1,4,8,12,16").split(",").map(Number);
// ------------------------------------------------

const { BASE_URL, LABEL, PROJECT, NEXTAUTH_SECRET, SESSION_TOKEN, OUT = "./out" } = process.env;
mkdirSync(OUT, { recursive: true });

const signedCookie = (token, secret) =>
  encodeURIComponent(`${token}.${crypto.createHmac("sha256", secret).update(token).digest("base64")}`);

async function cdpMetrics(client) {
  try { await client.send("HeapProfiler.collectGarbage"); } catch {}   // §6.1/6.2
  const { metrics } = await client.send("Performance.getMetrics");
  const by = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  return { jsHeapMB: +(by.JSHeapUsedSize / 1048576).toFixed(1), cdpNodes: by.Nodes };
}

async function settle(page, ms = 900) {
  try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch {}
  await page.waitForTimeout(ms);   // §6.5 — ≥ feature debounce
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{
    name: "better-auth.session_token", value: signedCookie(SESSION_TOKEN, NEXTAUTH_SECRET),
    domain: new URL(BASE_URL).hostname, path: "/", httpOnly: true, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Performance.enable");
  await client.send("HeapProfiler.enable");

  const report = { label: LABEL, baseUrl: BASE_URL, samples: [] };
  await page.goto(`${BASE_URL}${CONFIG.path(PROJECT)}`, { waitUntil: "domcontentloaded" });
  await settle(page, 1500);

  let opened = 0;
  for (const target of MILESTONES) {
    while (opened < target) { await CONFIG.openOne(page); opened++; await settle(page, 700); }
    await settle(page, 700);
    const cdp = await cdpMetrics(client);
    const dom = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return { liveNodes: document.querySelectorAll("*").length /*, …your markers via q()… */ };
    });
    // interaction latency
    let interaction = null;
    if (CONFIG.interactionTarget) {
      const el = page.locator(CONFIG.interactionTarget).last();
      if (await el.count()) {
        await el.click().catch(() => {});
        const t0 = Date.now();
        await el.type(CONFIG.interactionText, { delay: 12 }).catch(() => {});
        interaction = { typeMs: Date.now() - t0 };
        await page.waitForTimeout(700);
      }
    }
    report.samples.push({ tabs: target, ...cdp, ...dom, interaction });
    console.log(`[${LABEL}] N=${target}`, JSON.stringify(report.samples.at(-1)));
  }

  // Flame-graph trace of one interaction burst at max load.
  await client.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,v8,blink.user_timing",
    transferMode: "ReturnAsStream",
  });
  if (CONFIG.interactionTarget) {
    const el = page.locator(CONFIG.interactionTarget).last();
    if (await el.count()) { await el.click().catch(()=>{}); await el.type(CONFIG.interactionText,{delay:15}).catch(()=>{}); await page.waitForTimeout(800); }
  }
  const done = new Promise((r) => client.on("Tracing.tracingComplete", (e) => r(e.stream)));
  await client.send("Tracing.end");
  const stream = await done, chunks = [];
  if (stream) { for (;;) { const { data, eof } = await client.send("IO.read", { handle: stream }); chunks.push(data); if (eof) break; } await client.send("IO.close", { handle: stream }); writeFileSync(`${OUT}/trace-${LABEL}.json`, chunks.join("")); }

  writeFileSync(`${OUT}/report-${LABEL}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
```

> Note: the template shows the shape. Inline your `domSelectors` directly in the two `page.evaluate` callbacks (evaluate callbacks can't close over `CONFIG` — they run in the browser). Keep the CDP/GC/auth/trace plumbing exactly as-is.

## 9. Reference: metrics that tell the story

| Metric | Source | What it proves |
|---|---|---|
| Live DOM nodes | `querySelectorAll('*').length` | The headline "memory footprint" curve. Flat = inactive content unmounted. |
| Mounted-but-hidden panels | `[role=tabpanel][hidden]` (or feature equiv) | The mechanism: >0 and growing = the "mounted then hidden" anti-pattern still present. |
| Heavy per-item instances | count of the costly subtree/editor | Confirms only the active item is alive. |
| JS heap (after forced GC) | `Performance.getMetrics.JSHeapUsedSize` | Retained memory. |
| Interaction latency | wall-clock around a fixed input burst | The user-felt "sluggishness". |
| Trace file size | the two `trace-*.json` | Crude but honest: same interaction, more work = bigger trace. |

---

*Method authored from the prompt-playground tabs memory fix (issue #5454 / PR #5456) — but nothing here is specific to tabs. Swap §7's four items for any feature.*
