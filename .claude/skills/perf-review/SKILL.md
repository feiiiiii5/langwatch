---
name: perf-review
description: "Performance review: check changed files for known frontend perf anti-patterns (tab mount leaks, ungated disclosure queries, refetch storms, store rebuild costs). The degradation gate — run alongside /code-review."
user-invocable: true
argument-hint: "[diff, branch, or commit range]"
---

Review code changes for the performance anti-patterns below and sign off on each rule.

**What to diff:** If `$ARGUMENTS` is provided, use it as the diff target (a branch, commit range, or raw diff). Otherwise diff against `origin/main`, or the PR base branch if on a PR branch. If ambiguous, ask.

For each rule: **PASS** if no violations, or **FAIL** with every violation listed — one per line with `file:line` and the fix shape. Judgment rules emit **FLAG** with reasoning instead of FAIL.

The catalog below was extracted from real production fixes (#5454, #5455, PR #5456, PR #5588). When a new perf fix lands that doesn't match an existing rule, add it here — that's how this skill compounds.

## Deterministic rules

1. **Tabs must unmount inactive panels.** Every Ark UI / Chakra `Tabs.Root` added or modified in the diff has `lazyMount unmountOnExit` (or every `Tabs.Content` is manually gated on the active tab). Without it, every inactive tab's content tree — including any live queries inside it — stays mounted-but-hidden and keeps fetching/subscribing. Fix: add `lazyMount unmountOnExit` to `Tabs.Root`. If a panel must stay warm (e.g. an editor holding unsaved state), gate that one manually and say why in the review. *(#5455 pattern 1)*

2. **Disclosure-scoped queries gate on the disclosure's own open state.** A query (`useQuery`, tRPC `api.*.useQuery`) whose result is consumed **only** inside `Popover.Content` / `Menu.Content` / `Dialog` body must have `enabled` tied to that disclosure's own `open` state — not just `!!project?.id`. Otherwise it fires for every rendered trigger on mount. Fix: control the disclosure (`open`/`onOpenChange`) and pass `enabled: open && ...`. Exception: if the data also feeds the always-visible trigger (badge, count, disabled state), do NOT auto-fail — downgrade to FLAG and check whether gating changes visible behavior. *(#5455 pattern 2)*

3. **No per-item refetch storms.** Queries rendered N-per-collection (tab labels, list rows, table cells) must not each refetch on window focus/reconnect. Fix: `staleTime` + `refetchOnWindowFocus: false` on the per-item query, or lift to one parent query and pass data down. Symptom to imagine: user alt-tabs back and N requests fire at once. *(#5454, PR #5588)*

4. **Hidden content renders nothing heavy.** Conditional UI that is "hidden" via CSS (`display: none`, `hidden` attr, opacity) instead of unmounted, when the subtree contains queries, editors, charts, or `.map()` over data. Fix: conditional render (`{isOpen && <Heavy />}`), not conditional visibility.

## Judgment rules (FLAG + reasoning, not auto-FAIL)

5. **Store middleware partialize cost.** A `partialize` (zundo `temporal()`, `zustand/persist`) that maps/rebuilds whole collections (`tabs`, `nodes`, `chatWindows`) on every `set()`. Flag with an estimate of collection size and `set()` frequency; a debounce on the push softens but doesn't remove it. Fix is case-by-case — undo-history stores and localStorage persistence have different blast radii. *(#5455 pattern 3)*

6. **New query on an always-mounted hot path.** A query added to a component that is always mounted (layout, header, indicator) or rendered per-item. Ask: does this need to fire on mount, or on interaction? Justify or gate.

7. **Effect-driven state loops.** New `useEffect` that sets state consumed by its own dependency chain, or subscribes without cleanup. Flag render-loop and leak risk.

## Escalation

A contested finding, or a perf fix whose value is disputed → don't argue statically. Run **/perf-prove** (live A/B profiling against pre-fix and post-fix servers) and let the broken→fixed metric matrix decide.

## Output format

1. Verdict table: rule → PASS / FAIL / FLAG.
2. Violations grouped by file, each with `file:line`, the rule number, and the concrete fix shape.
3. One line at the end: whether /perf-prove escalation is warranted for anything found.
