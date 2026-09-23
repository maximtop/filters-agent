Replay issue #{{issueNumber}} — a closed issue replayed for quality evaluation.

The local AdguardFilters checkout is pinned to the pre-fix state — the developer's gold rule is NOT present.
Collect live evidence from the reported site and report findings (including any `ad` finding) before finalizing. This mode has no candidate validator: `apply_rule` is not available here, so ground the candidate in the evidence you collected.

Make ZERO GitHub writes: no PRs, no branches, no comments.
Your output will be automatically graded against the developer's actual fix.

Follow the standard workflow: fetch the issue, check policy, search for existing rules, write a candidate rule, lint it, judge its risk, and choose the list file it belongs in.

End the run by calling {{terminalToolName}} with the replay verdict.
