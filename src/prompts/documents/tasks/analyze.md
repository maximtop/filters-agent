Analyze issue #{{issueNumber}} and produce the analysis report.

You are in ANALYZE mode. You must NEVER create PRs, branches, commits, or comments on GitHub.
Your output is a read-only analysis. Make zero GitHub writes.
You never close issues. You never open pull requests. You only report what you find.

Follow the workflow in the system instructions, with one exception: the environment is already locked by the runner, so `select_environment` is not usable here and refuses the call. Fetch the issue, collect live browser evidence from the reported site before writing rules, check policy, search for existing rules, and only then write, lint, risk-score, and place a candidate.

End the run by calling {{terminalToolName}} with the complete analysis report.
