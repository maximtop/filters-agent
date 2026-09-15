import { join } from 'node:path';
import { readListFileIdentity } from './placement-map';
import type { DeclaredPlacement } from '../types/declared-placement';

/**
 * The run instruction's declared placement, bound to the run's own checkout.
 *
 * The declaration names a file; the checkout says what that file calls itself and whether it is
 * there at all. Binding the two is what lets the resolver answer with the list's own name instead
 * of a path, and lets a run whose declared file does not exist yet still name it as the answer.
 */

/**
 * Confidence a declared placement answers with.
 *
 * The declaration is run configuration, not an inference: nothing is left to be uncertain about, so
 * it answers at full confidence while every routed placement stays below it.
 */
export const DECLARED_PLACEMENT_CONFIDENCE = 1;

/**
 * The one reason a declared placement gives.
 */
export const DECLARED_PLACEMENT_REASON = 'declared by the run instruction';

/**
 * The declared placement as the run's checkout knows it.
 */
export interface DeclaredPlacementTarget {
    /**
     * Checkout-relative file the instruction declared, rendered for this run.
     */
    filePath: string;

    /**
     * The declared file's own `! Title:` value; absent when the file carries no title comment or is
     * not in the checkout.
     */
    title?: string;

    /**
     * Whether the declared file is absent from the run's checkout, so an edit would create it.
     */
    absentFromCheckout: boolean;
}

/**
 * State the reason a declared answer names a file the checkout does not hold.
 *
 * The declaration stays the answer — the repository said where its rules go — but the edit planner
 * needs the file to exist, so the resolution says plainly why no insertion comes with it instead of
 * leaving an empty plan unexplained.
 *
 * @param filePath - Checkout-relative declared file.
 * @returns The reason line the resolution carries beside the declaration reason.
 */
export function declaredPlacementAbsentReason(filePath: string): string {
    return (
        `the declared file '${filePath}' is not in this checkout, so no insertion can be planned ` +
        'for it until the file exists'
    );
}

/**
 * Bind one rendered declaration to the run's checkout.
 *
 * @param checkoutPath - Absolute root of the run's filters checkout.
 * @param declared - The instruction's declaration, rendered for this run.
 * @returns The declared file as the checkout knows it: its own title, and whether it exists.
 */
export function bindDeclaredPlacement(
    checkoutPath: string,
    declared: DeclaredPlacement,
): DeclaredPlacementTarget {
    const identity = readListFileIdentity(join(checkoutPath, declared.filePath));
    return {
        filePath: declared.filePath,
        absentFromCheckout: !identity.present,
        ...(identity.title === undefined ? {} : { title: identity.title }),
    };
}
