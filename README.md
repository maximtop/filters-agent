# filters-agent

A GitHub Action that investigates a reported filtering issue in a real browser running an
ad-blocker extension, proposes and verifies a candidate filter rule, and posts a short report as
a comment on the issue.

## What it does

When it runs against an issue, `filters-agent`:

1. Reads the issue and the page it reports a problem on.
2. Reproduces the problem in a real browser with an ad-blocker extension loaded.
3. Proposes a candidate filter rule and verifies it against that extension — the action reads the
   extension's own state back after applying the rule, rather than trusting its own report of what
   it did.
4. Posts a short report as a comment on the issue, and uploads the full run (report, traces,
   screenshots) as a workflow artifact.

## Requirements

- An OpenAI-compatible LLM endpoint reachable from GitHub-hosted runners. The action calls it
  directly; nothing is proxied or hosted for you.
- GitHub Issues enabled on your repository — that's where reports come from, and where the action
  posts its findings.

## Connect it to your repository

1. Copy [`docs/examples/filters-agent-workflow.yml`](docs/examples/filters-agent-workflow.yml)
   into your repository's `.github/workflows/`.
2. Add your LLM provider's API key as the repository secret `FILTERS_AGENT_LLM_API_KEY`. The
   endpoint URL and the two model names are not secret — edit them directly in the workflow file
   you just copied, which ships with an OpenRouter-shaped placeholder.
3. Optional: if your users run something other than the built-in AdGuard Browser Extension, add
   `.github/filters-agent/AGENTS.md` to your repository describing that blocker. See
   [`docs/modules/browser-with-extension.md`](docs/modules/browser-with-extension.md) for how the
   module drives a browser extension, and the example instructions in
   [`src/prompts/documents/instructions/`](src/prompts/documents/instructions/) — specifically
   `ublock-origin-firefox.md`, `ublock-origin-lite.md` and `edge-mv2.md` — for the shape a custom
   instruction takes. The same file is also how a repository that stays on the built-in extension
   points the run at its own filter guidance: see
   [An instruction that only adds guidance](#an-instruction-that-only-adds-guidance).
4. Label an issue `filters-agent` (or run the workflow manually with an issue number) to start a
   run.
5. The report appears as a comment on the issue. The full run — report, traces, screenshots — is
   uploaded as a workflow artifact; find it on the workflow run's Summary page. Preparation steps in an instruction run inside the action image, which provides `curl`, `jq`, `node`, `git` and `unzip`.

Every job builds the action's own Docker image from scratch, including two browsers, before it
can start — expect it to add several minutes ahead of the actual analysis.

## What works today

Out of the box, with no `.github/filters-agent/AGENTS.md` in your repository, the action
investigates and verifies against the **built-in AdGuard Browser Extension** in Chromium.

An instruction file switches the run to another blocker. Three examples ship under
`src/prompts/documents/instructions/`:

- **uBlock Origin in Firefox** runs end to end. The example declares `launch: firefox` and a
  managed-storage user-filters file; the action force-installs the current signed uBO release
  through Firefox enterprise policies, applies the candidate rule through that file, relaunches the
  browser and reads the file back. Copy `ublock-origin-firefox.md` as your instruction and adjust
  the list selection to the lists your repository publishes.
- **uBlock Origin Lite** (Chromium) does not run yet: nothing in a run writes its rule file, so a
  run configured for it refuses immediately, before it checks out your repository or spends any
  LLM budget.
- **The AdGuard Browser Extension (MV2 build) in Microsoft Edge** reads its state back the same
  way the built-in route does, but the action cannot yet drive a branded Edge browser.

See [`docs/modules/browser-with-extension.md`](docs/modules/browser-with-extension.md) for the
detail behind each route.

### How a rule gets applied between phases

To measure a candidate the action has to put your repository's filters and the candidate rule into
the blocker before each phase. Your instruction decides how, and there are three shapes:

- **No instruction, or one declaring `application: adguard-extension`.** The built-in AdGuard route.
  Its steps are a fixed message protocol, so the action performs them itself in code: wait for the
  extension to finish installing, import the prepared settings, turn off any filter the import left
  on that your settings do not name, and save the candidate as the only user rule. No model is
  involved, so an application takes seconds instead of the several minutes a model spent sending the
  same messages one turn at a time.
- **An instruction declaring a file-backed read** (`read: managed-storage-file` or
  `read: user-rules-file`). The action writes the file itself, relaunches the browser so it picks the
  file up, and reads it back. The uBlock Origin in Firefox example is this shape.
- **An instruction writing its own `## Rule application` steps.** The model performs exactly those
  steps — nothing else — which is how a blocker with its own way of adding a rule gets driven.

Whichever shape applies, the action then reads the blocker's own state back and credits the phase
only when that state holds exactly what it expected: the candidate rule and nothing else for a
candidate phase, no user rule at all for a baseline. Nothing is taken on the model's word.

### An instruction that only adds guidance

An instruction does not have to switch the blocker. Every part of it is optional on its own: leave
out the preparation, the launch, the placement, the issue selection or the report template, and the
run keeps its built-in behaviour for that part. The application steps are the one part no run can
invent, so an instruction that adds nothing but guidance documents names the built-in route that
applies its rules, on one line:

```
application: adguard-extension
```

`adguard-extension` is the only route today: the built-in AdGuard Browser Extension in Chromium,
which the action prepares, launches, applies and reads back itself. Without that line an instruction
is expected to carry its own `## Rule application` and `## State verification` sections, and a run
whose instruction carries neither spends its whole budget before refusing to apply anything.
Declaring the route *and* writing those sections is a contradiction: the run fails at start, naming
the instruction and both facts.

A complete guidance-only instruction, for a repository whose users run the built-in extension:

```markdown
# Run instruction: AdguardFilters

The run's blocker is the built-in AdGuard Browser Extension in Chromium — the host prepares,
launches, applies and reads it back itself. This file adds nothing to that route but the guidance
documents this repository writes its rules against.

application: adguard-extension

The run loads its filter guidance at start from these role documents:

- [AdGuard filter syntax](https://github.com/AdguardTeam/KnowledgeBase/blob/master/docs/general/ad-filtering/create-own-filters.md)
- [AdGuard filter policy](https://github.com/AdguardTeam/KnowledgeBase/blob/master/docs/general/ad-filtering/filter-policy.md)
- [AdguardFilters contributing guide](https://github.com/AdguardTeam/AdguardFilters/blob/master/CONTRIBUTING.md)

Rule placement is deliberately not declared: the deterministic routing already mirrors this
repository's `<Filter>/sections/*.txt` layout, and one declaration would force every rule into
a single file.
```

The link labels are what bind the documents: a label containing `syntax`, `policy` or
`contributing` binds that role, and `lookup_rule_guidance` then answers every topic from your
documents instead of the pinned AdGuard KnowledgeBase. A topic whose role you did not link is
answered by a notice saying so, which the run's report carries as missing information.

### Where an accepted rule goes

With no instruction the action places the rule the way the AdGuard filter repository is laid out:
the page's language picks the filter, the rule's kind picks the section. A repository that files
its rules elsewhere says so in its instruction, on one line:

```
placement: filters/filters-{{year}}.txt comment: ! {{issueUrl}}
```

The path is relative to your checkout and may carry `{{year}}`, the year the run starts on in UTC.
The optional `comment:` part is the line written immediately before the rule and may carry
`{{issueUrl}}`, the URL of the issue being worked; leave it out and no comment is written. The
declaration wins over the language routing outright: the action proposes that file and appends the
rule at its end. Keep the file in your repository — a declared file that is not in the checkout is
still what the report names, but no edit can be proposed for it until it exists. Declare it once:
a second `placement:` line, an absolute path, or a placeholder other than those two fails the run
at start, naming the instruction.

The two uBlock Origin examples declare the placement uAssets uses, so a repository that copies one
in gets the current year's filters file and a preceding comment holding the issue URL.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `repository` | No | Repository slug (owner/repo) the run identifies itself with; defaults to the runner's `GITHUB_REPOSITORY`. |
| `issueNumber` | No | Number of the issue to analyze; selecting it runs the single-issue mode. |
| `backlog` | No | `'true'` analyzes the repository's open-issue backlog instead of a single issue. |
| `limit` | No | Maximum number of backlog issues analyzed per run; unset means up to 50 issues in one job, each a paid LLM run; the loop also stops at its wall-clock budget (default 5h 30m, overridable by an input) so one job stays under GitHub's 6-hour cap. |
| `trustedRoles` | No | Comma-separated GitHub author associations trusted to change a backlog issue's revision; defaults to `OWNER,MEMBER,COLLABORATOR`. |
| `maxRevisionsPerWindow` | No | Maximum revision-marked reports one backlog issue may receive inside the rolling `revisionWindowMs` window; defaults to the queue's revision budget. |
| `revisionWindowMs` | No | Length of the rolling window the revision budget counts against, in milliseconds; defaults to the queue's revision window (24 hours). |
| `backlogWallClockBudgetMs` | No | Wall-clock budget for the whole backlog loop, in milliseconds; defaults to 5h 30m so one job stays under GitHub's 6-hour cap. The loop stops taking new issues once the remaining time can no longer fit one more issue's own investigation budget. |
| `executors` | No | Comma-separated executor names the analysis session may use; the public value is `browser_extension`; empty means every registered executor. |
| `instructionPath` | No | Path of the run instruction file, relative to the checkout; when unset, the checkout's default instruction at `.github/filters-agent/AGENTS.md` is loaded when present. |
| `artifactsDir` | No | Directory the run writes its artifacts to; defaults to `filters-agent-artifacts/artifacts` under the checkout. |
| `model` | No | Reasoning-model slug overriding the LLM runtime's configured model. |
| `noComment` | No | `'true'` skips posting the report as an issue comment; the report is still written to the artifacts directory. |
| `checkoutPath` | No | Path of the analyzed checkout; defaults to the runner's `GITHUB_WORKSPACE`. |
| `githubToken` | No | GitHub API token the run reads issues with; in practice mandatory in every run, since the action only serves GitHub-read modes — a missing token fails the job named, even together with `noComment`. |
| `llmBaseUrl` | Yes | OpenAI-compatible API base URL of the LLM provider. |
| `llmApiKey` | Yes | API key of the LLM provider; pass it from a repository secret. |
| `llmModel` | Yes | Default reasoning-model slug for the run's LLM sessions. |
| `llmVisionModel` | Yes | Model slug used for vision steps that read screenshots. |
| `llmProviderRouting` | No | JSON routing preferences for an OpenRouter-compatible gateway, sent as the `provider` object on every request — for example `{"ignore":["Together"]}` to route around a faulting upstream provider. Plain configuration, not a secret; leave it unset for a gateway that does not understand the field. |

### Outputs

| Output | Description |
| --- | --- |
| `artifacts-dir` | Directory the run wrote its artifacts to, relative to the checkout; feed it to `actions/upload-artifact`. |
| `status` | How the run sealed: `success`, `partial_failure` (backlog runs with per-issue failures), or `failed`. |

## License

[MIT](LICENSE) covers the sources in this repository.

The action image is built on your runner at the start of every run, and the build downloads two
browsers from their publishers: Firefox through Playwright, and the CloakBrowser Chromium build
from CloakHQ. The CloakBrowser binary comes under its own
[binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md), not under
MIT: using it is free, redistributing it is not. Read it before you run the action in your
organization, and do not push an image that contains the binary to a public registry.
