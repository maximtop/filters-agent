/**
 * Browser-extension release targets supported by the local Chromium harness.
 */
export const ExtensionBuildTarget = {
    ChromeMv3: 'chrome-mv3',
} as const;

/**
 * Every ExtensionBuildTarget value, for schemas and exhaustive listings.
 */
export const EXTENSION_BUILD_TARGET_VALUES = Object.values(ExtensionBuildTarget);

/**
 * ExtensionBuildTarget value.
 */
export type ExtensionBuildTarget = (typeof ExtensionBuildTarget)[keyof typeof ExtensionBuildTarget];
