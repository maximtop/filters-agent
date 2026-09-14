import { ExtensionManifestVersion } from '../environment/extension-preparation';
import { ExtensionBuildTarget } from '../types/extension-build-target';

export const LOCAL_BROWSER_SUPPORT = {
    family: 'chromium',
    extensionTarget: 'chrome-mv3',
    manifestVersion: ExtensionManifestVersion.Mv3,
} as const;

/**
 * Extension provenance fields required by the local browser support gate.
 */
export interface PreparedLocalExtensionProvenance {
    /**
     * Extension release target produced by the build.
     */
    target: string;

    /**
     * Manifest generation read from the built extension manifest.
     */
    manifestVersionMajor: number;
}

/**
 * Reject a requested extension target outside the currently supported local browser matrix.
 *
 * @param target - Optional extension build target read from a local case configuration.
 * @returns Nothing after the target is proven compatible.
 */
export function assertSupportedLocalBuildTarget(
    target: string | undefined,
): asserts target is typeof ExtensionBuildTarget.ChromeMv3 | undefined {
    if (target !== undefined && target !== LOCAL_BROWSER_SUPPORT.extensionTarget) {
        throw new Error(
            'Local browser runs currently support only Chromium with the chrome-mv3 ' +
                `extension target; received ${target}.`,
        );
    }
}

/**
 * Reject prepared extension output that violates the supported Chromium MV3 runtime contract.
 *
 * @param provenance - Built extension target and observed manifest generation.
 * @returns Nothing after both runtime properties are proven compatible.
 */
export function assertSupportedPreparedExtension(
    provenance: PreparedLocalExtensionProvenance,
): void {
    if (
        provenance.target !== LOCAL_BROWSER_SUPPORT.extensionTarget ||
        provenance.manifestVersionMajor !== LOCAL_BROWSER_SUPPORT.manifestVersion
    ) {
        throw new Error(
            'Local browser runs currently support only Chromium with an MV3 extension; ' +
                `prepared target=${provenance.target}, ` +
                `manifest_version=${provenance.manifestVersionMajor}.`,
        );
    }
}
