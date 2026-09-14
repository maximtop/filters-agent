# Built-in AdGuard Browser Extension application instruction

This document is the built-in conversion of the AdGuard options-page driver: the one way rules are
applied when the run's blocker is the AdGuard Browser Extension. The steps run inside a controlled
browser session that already has the prepared extension loaded.

## Rule application

Perform exactly these steps, invent none:

1. Open the AdGuard Browser Extension options page at `chrome-extension://<extension id>/pages/options.html`.
   Use the extension id of the prepared extension your session was launched with.
2. Wait until the options application reports it has finished initializing before changing
   anything: call `send_extension_message` with `{"type": "getIsAppInitialized"}` and repeat the
   call while it answers `false`. Its background message handlers and default filters settle
   asynchronously after a fresh install, and settings applied in that window can be overwritten.
3. Apply the prepared settings through the options application: call `send_extension_message` with
   `{"type": "applySettingsJson", "data": {"json": "<the settings payload your task hands you>"}}`,
   passing the payload exactly as written, so the extension enables exactly the official filters
   the prepared expectation names and its Tracking-protection state. Do not add, remove, or edit
   any other filter.
4. If your goal is to apply the candidate rule: call `send_extension_message` with
   `{"type": "saveUserRules", "data": {"value": "<the candidate rule your goal names>"}}`, passing
   the candidate rule exactly as written, as one line, and nothing else. No rewrites, no extra
   rules, nothing removed.

## State verification

After your steps the host reads the blocker state back itself and credits the phase only when that
state contains exactly the rule content it expected. The host reads the live extension state:

read: extension-state user-rules
