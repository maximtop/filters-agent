/**
 * The AdGuard Browser Extension app-message vocabulary this run speaks.
 *
 * One declaration for both sides of the boundary: the host's own state read sends these types, and
 * the built-in application instruction names them to the model. A message type spelled twice is a
 * message type that can drift, and the one that drifts silently is the worst kind — the extension
 * answers `undefined` and the step looks like it ran.
 *
 * Every member here was proven against the pinned build by the retired options-page driver (`git
 * show 1ea6e065^:src/browser/adguard-extension.ts`); nothing is invented. In particular the driver
 * had no _enable_ counterpart to `DisableFilter`, so the convergence the instruction performs only
 * ever turns filters off.
 */
export const AdGuardExtensionMessageType = {
    /**
     * Whether the fresh-install bootstrap has finished. Settings applied before it answers `true`
     * can be overwritten by late bootstrap work.
     */
    GetIsAppInitialized: 'getIsAppInitialized',

    /**
     * The options application's current state: app version, settings values, and the filter
     * metadata carrying each filter's `filterId` and `enabled` flag.
     */
    GetOptionsData: 'getOptionsData',

    /**
     * The installation's complete settings export as a JSON string.
     */
    LoadSettingsJson: 'loadSettingsJson',

    /**
     * Import a complete settings document. The pinned build refuses anything partial.
     */
    ApplySettingsJson: 'applySettingsJson',

    /**
     * Replace the user-rules text with the supplied value.
     */
    SaveUserRules: 'saveUserRules',

    /**
     * Turn one filter off by its `filterId`.
     */
    DisableFilter: 'disableFilter',
} as const;

/**
 * AdGuardExtensionMessageType value.
 */
export type AdGuardExtensionMessageType =
    (typeof AdGuardExtensionMessageType)[keyof typeof AdGuardExtensionMessageType];
