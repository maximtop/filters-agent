# Run instruction: uAssets-style filter repository with uBlock Origin in Firefox

This file is the run instruction for a uAssets-style filter-list repository. The run's blocker is
uBlock Origin (uBO) in Firefox, force-installed from the current signed release through Firefox
enterprise policies. Every step below is the run's obligation — perform it exactly as written:
the host reads the blocker state back itself and credits a phase only when that state holds
exactly what this instruction declares.

The run loads its filter guidance at start from these role documents:

- [uBlock Origin static filter syntax](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)
- [uAssets filtering policy](https://github.com/uBlockOrigin/uAssets/wiki/Filtering-policy)

## Preparation

1. Download the current signed Firefox build of uBlock Origin — the current release version only,
   never a frozen or pinned tag. Ask the public GitHub releases API
   `https://api.github.com/repos/gorhill/uBlock/releases/latest` and take the asset whose name
   ends with `.firefox.signed.xpi`; save it inside the run workspace.
2. In the run's filters checkout create the user-filters file
   `filters-agent/ublock/user-filters.txt` empty. The file read-back credits the Baseline phase
   only when the file is empty, so an empty file is the baseline ground state; the rule-application
   step appends the candidate rule to it.
3. Generate the Firefox enterprise policies payload: under `ExtensionSettings`, keyed by
   `uBlock0@raymondhill.net`, set `installation_mode` to `force_installed` and `install_url` to
   the absolute `file://` URL of the saved XPI; under `3rdparty.Extensions` for the same
   extension id set `adminSettings` with `userFilters` equal to the exact contents of
   `filters-agent/ublock/user-filters.txt` and `selectedFilterLists` selecting the baseline lists
   this repository publishes plus `user-filters` — without `user-filters` in the list, uBO never
   applies `userFilters` at all. The file read-back cannot see `selectedFilterLists`; it credits a
   phase from the file's content alone.
4. Before finishing, assert both artifacts exist in the run workspace: the signed XPI and the
   policies payload that references it.

## Rule application

Maintain the user-filters file; the candidate rule reaches uBO only through it. Perform the steps
in order, invent none:

1. If your goal is to apply the candidate rule: append it to
   `filters-agent/ublock/user-filters.txt` as one exact line at the end of the file — no rewrites,
   no extra rules, nothing removed.
2. Regenerate the managed-storage payload from the file's exact contents: update
   `adminSettings.userFilters` under `3rdparty.Extensions.uBlock0@raymondhill.net` to hold those
   contents verbatim.
3. Restart the browser session that runs the prepared uBO profile, so the force-installed uBO
   re-reads the regenerated payload; uBO consumes managed storage while Firefox applies the
   policies, not from a running session's settings UI.

## State verification

After the application steps the host reads the blocker state back itself; it never accepts the
session's own report. The host's declaration:

read: managed-storage-file filters-agent/ublock/user-filters.txt

The target is relative to the run's checkout root; the host resolves it there. The file must be
the very one preparation created and the application steps maintain — one rule per line, the
candidate appended last.

File-backed application is not supported yet: no session in this run writes the file this
declaration names, so a run loading this example refuses before any paid work, naming the
declared method (see `docs/modules/browser-with-extension.md`).

## Issue selection

Take issues that report broken filtering on real pages — ads, banners, trackers or similar
elements this repository's lists should block. Work one issue whose fix is a filter rule; skip
feature requests, infrastructure or meta tickets, and anything fixable only by changing uBO
itself rather than the lists.

- labels: T: Ads
- max-age-days: 30

## Report template

### Outcome

{{outcome}}

{{outcomeReason}}

{{versionUpdateHint}}

### Reproduced symptom

{{symptom}}

### Rule

{{rule}}

### Executor and version

{{executor}} {{executorVersion}}

### Policy rationale

{{policyRationale}}

### Place in the list

{{listPlace}}

Proposed placement: appended at the end of the current year's filters file, with the issue URL in
a preceding comment. The file named above is that list file; the user-filters file the run
verified against is the in-browser application path only.

### Missing information

{{missingInformation}}

### Artifacts

{{artifactsLink}}
