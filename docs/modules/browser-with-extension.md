# Browser with an extension

The module launches a real browser with an ad-blocker extension forced into it, and hands the
session to the agent's page tools. One interface, two extension channels, one per browser family:
Chromium-family engines load an unpacked extension directory (`adguardExtensionPath`), Firefox
loads a signed XPI through enterprise policies (`firefoxPolicies`). Each family's channel is a
compile-level pairing: an engine asked for a channel it cannot honor rejects the launch loudly
instead of dropping the configuration.

## Interface

- **Input**: a browser engine (`IBrowserEngine`), the extension install payload, and the
  extension's policies.
    - Firefox: signed XPI path (absolute, `file://` URL is built by `buildFirefoxPolicies`) and
      enterprise policies carrying `ExtensionSettings` plus `3rdparty.Extensions` managed storage.
    - Chromium: unpacked extension directory path (`adguardExtensionPath`).
- **Output**: a `BrowserSession` whose page tools — `get_dom`, `screenshot`, `inspect_page_state`,
  `evaluate_js`, `get_console_log`, `stabilize_page` — work unchanged on top of either family.

### Failure modes

- **The browser did not start.** The launch path raises `BrowserLaunchError` before any tool is
  reachable. Callers escalate to analysis-only output; nothing extension-specific is diagnosable
  past this point.
- **The extension did not load.** The session is up, but the expected extension behavior is
  absent — the reporting page loads its ordinary content with no filtering. There is no
  extension-settings API reachable from the harness (see Firefox limitations below), so the proof
  of load is behavioral: a page fixture with a known third-party request and a policy that filters
  it. `tests/browser/firefox-ublock-session.test.ts` is that proof for Firefox; it polls for the
  block because uBO engages on its own schedule — the install probe recorded a 30–45 s warm-up on
  fresh force-installs, while the integration gate saw the block on the first navigation in local
  runs. Poll for the block; assume neither an instant nor a fixed warm-up.

## Install mechanism for Firefox — settled

**Path A: Playwright policies.** The patched Playwright Firefox build reads a custom
`policies.json` pointed at by the `PLAYWRIGHT_FIREFOX_POLICIES_JSON` environment variable (absolute
path; Playwright ≥ 1.53). The policies force-install the signed XPI (`ExtensionSettings` →
`installation_mode: force_installed`, `install_url: file://…xpi`) and feed managed storage through
the same file's `3rdparty.Extensions` block. `FirefoxEngine` stages the file into the profile
directory and merges the environment variable into the launch; `BrowserSession.create` accepts the
policies on `firefoxPolicies` and drives the persistent context for them.

The alternative — Puppeteer with WebDriver BiDi and `webExtension.install` — also passed every
behavioral check on the real signed uBO XPI, and its installs proved persistent across restarts,
revising the earlier expectation of temporary add-ons. It lost on architecture, not on behavior.
Recorded verbatim from the probe (`tmp/probe/firefox-install-probe.mjs`, see its header):

> BiDi needs a second driver and a second browser channel, replaces none of the
> Playwright page tools, and exposes no engine-neutral seams; playwright-core cannot drive a
> vanilla Firefox binary, and the patched build cannot be driven by WebDriver BiDi alone.

Path B's code and its `puppeteer-core` devDependency were deleted in the same change.

## uBlock Origin managed storage

Extension ID: `uBlock0@raymondhill.net` (uBO's published Firefox ID). uBO reads `adminSettings`
from `browser.storage.managed`; filters arrive as a `userFilters` string of filter lines, and
`selectedFilterLists` containing `user-filters` applies them (uBlock-issues#3685). Subscribing only
`user-filters` also keeps a fresh install from downloading real filter lists.

```json
{
    "policies": {
        "ExtensionSettings": {
            "uBlock0@raymondhill.net": {
                "installation_mode": "force_installed",
                "install_url": "file:///abs/path/ublock-origin.firefox.signed.xpi"
            }
        },
        "3rdparty": {
            "Extensions": {
                "uBlock0@raymondhill.net": {
                    "adminSettings": {
                        "userFilters": "||ads.example^",
                        "selectedFilterLists": ["user-filters"]
                    }
                }
            }
        }
    }
}
```

The policies file is built by `buildFirefoxPolicies({ extensionId, xpiPath, managedStorage })` —
the managed storage passes through verbatim, so the uBO shape above is the caller's data. The
result is handed to `BrowserSession.create` as `firefoxPolicies`; the executor instruction (issue 12) owns the actual filter content.

## Proving the block: the network-log seam vs the DOM

Observed on Firefox with uBO active, recorded by the install probe and asserted by the
integration gate:

- A request blocked by uBO fires Playwright's `requestfailed` with failure error text
  `NS_ERROR_ABORT`; `BrowserSession` records it in `getNetworkLog()` with `statusCode: 0`.
- The DOM corroborates: a blocked image never decodes, so `img.naturalWidth === 0` — observable
  through `evaluate_js`.

Neither signal alone attributes a block, and two traps are recorded from this exact work:

- **uBO exempts loopback hosts from blocking by design.** A fixture serving its "ad" from the
  loopback server (any port) can never produce a blocking signal.
- **An unresolvable host imitates a block.** `ads.example` does not resolve, so without uBO the
  same request would still land as `statusCode 0` with `naturalWidth === 0` — from a DNS failure
  (`NS_ERROR_UNKNOWN_HOST`), not a cancel.

The discriminating signal is the failure error text: extension cancel is `NS_ERROR_ABORT`, DNS
failure is `NS_ERROR_UNKNOWN_HOST`. The integration gate asserts both the network-log entry and
the error text; the DOM proof travels with them.

## Evidence design: what the host verifies itself

Between an A/B/C phase opening and its observation, the model applies (or plugs) the
candidate by following an application instruction's steps. Trust ends at the model's last step:
two resolved decisions govern what the recorded proof may claim.

**Decision 1 — the host reads the blocker state back itself.** After the model's steps the host
opens the state at the instruction's declared read and credits the phase only on exact match:

- **candidate (phase C)**: the user-rule content, newline-joined, hashes to exactly the
  candidate's sha256 (`candidateDigest`) — one extra user rule is a different state;
- **baseline (phase B and the prepared launch)**: the enabled filter list set equals the prepared
  set exactly, and user rules stay empty;
- a `user-rules-file` or `managed-storage-file` read verifies the file at the declared path by
  content hash. Neither method can observe the enabled filter set, so phase B is credited on empty
  user rules and phase C on the exact content alone; the application detail records what could not
  be observed, and the enabled filter set is `null` — rendered as not observed, never an empty list.

**File-backed application is not supported yet.** Preparation can write only inside its own
workdir and is never told where the run's checkout is, and the application session carries page
tools only — so no session in a run ever writes the file a `user-rules-file` or
`managed-storage-file` declaration names, and the host would always read back a file the run
itself never populated. Rather than discover that late, after paying for a whole investigation, a
run whose instruction declares one of these two methods refuses immediately — before the
repository checkout, the issue fetch, or any LLM call — naming the declared method and
`InfrastructureFailureReason.FileBackedApplicationUnsupported`. The uBlock Origin and uBlock Origin
Lite examples declare exactly these methods and so always refuse today; the built-in and Edge MV2
instructions declare `extension-state`, which this limitation does not touch.

**Decision 2 — the AdGuard options-page driver is retired.** Its knowledge became the built-in
instruction (`src/prompts/documents/instructions/adguard-extension.md`, which a run without its
own instruction reads through the prompt-document loader) and its code path was deleted in the
same change. The instruction's steps run through the application session's one declared write
tool, `send_extension_message`: it sends a runtime message from the prepared blocker surface page
only — any other page refuses — and returns the background response, so `evaluate_js` on that
privileged surface stays read-only and the host-assembled action log records every message. The
host builds the settings payload from the prepared expectation (the enabled official filters) and
the task hands it over as a fill, replacing the retired driver's settings-import URL. The
decision-1 read-back covers the AdGuard extension too: the built-in instruction declares
`read: extension-state user-rules`, so the host queries the running extension's own options data,
user rules, and limit counters over its message transport.

Three properties of the recorded evidence follow:

- **The action log is host-assembled** from the application session's recorded tool calls. It is
  evidence of what was done, never that it was done — the model's self-report of its own steps
  never enters the proof.
- **A missing instruction section is a recorded refusal, never a guess.** An instruction with no
  rule-application section (`no-application-method`) or no state-verification section
  (`no-verification-method`) refuses before any model turn and the gap lands in the run's
  limitation record; a method the declaration names but the executor cannot read refuses the same
  way.
- **The phase credit is exact.** A near miss — one added user rule, one filter off the prepared
  set — reads back as unverified, the phase never opens, and the mismatch detail names what the
  read-back actually contained.

## Firefox limitations

- **Main-world evaluation.** The trusted-page evaluator's isolated CDP world does not exist on
  Firefox; `createTrustedPageEvaluator` probes CDP once, falls back to main-world
  `page.evaluate`, and keeps that choice per page. The isolated-world anti-tamper hardening is
  degraded accordingly: evaluation results can be influenced by page scripts.
- **No `moz-extension://` access.** uBO's own pages cannot be opened or driven, so extension
  settings and version cannot be verified the way the Chromium reporter flow does. Verification
  is the managed-storage contract plus observed filtering behavior.
- **Signed XPIs only.** Firefox has no unpacked-directory equivalent of the Chromium load flag;
  `FirefoxEngine` rejects a non-empty `extensionPaths` with a configuration error,
  and Chromium-family engines conversely reject `firefoxPolicies`. Each family must use its own
  channel.
