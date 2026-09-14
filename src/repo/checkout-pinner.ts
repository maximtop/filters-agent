import { execSync } from 'node:child_process';

/**
 * Thrown when a git operation fails (dirty checkout, invalid commit, etc.).
 */
export class CheckoutPinError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CheckoutPinError';
    }
}

/**
 * Pin a local git checkout to a specific commit (detached HEAD).
 *
 * Rejects empty or whitespace-only commitSha — the caller must guard against non-merged-fix cases
 * that have no base commit (Finding 1).
 *
 * @param checkoutPath - Absolute path to the git repository.
 * @param commitSha - The non-empty commit SHA to pin HEAD to.
 * @returns The previous HEAD ref (commit SHA or branch name) for later restoration.
 * @throws {CheckoutPinError} If the checkout has uncommitted changes, commitSha is empty, or the
 *   commit is invalid.
 */
export function pinCheckout(checkoutPath: string, commitSha: string): string {
    if (!commitSha || commitSha.trim().length === 0) {
        throw new CheckoutPinError(
            'Cannot pin checkout: commitSha must be a non-empty string. ' +
                'Non-merged-fix cases have no base commit — skip pinning for those.',
        );
    }
    const status = execSync('git status --porcelain', {
        cwd: checkoutPath,
        encoding: 'utf8',
    }).trim();
    if (status.length > 0) {
        throw new CheckoutPinError(
            `Checkout at ${checkoutPath} has uncommitted changes. Stash or commit before pinning.`,
        );
    }
    const previousRef = getCurrentCommit(checkoutPath);
    execSync(`git checkout --detach ${commitSha}`, {
        cwd: checkoutPath,
        encoding: 'utf8',
        stdio: 'pipe',
    });
    return previousRef;
}

/**
 * Restore a git checkout to a previously saved ref.
 *
 * @param checkoutPath - Absolute path to the git repository.
 * @param ref - The branch name or commit SHA to restore to.
 */
export function restoreCheckout(checkoutPath: string, ref: string): void {
    execSync(`git checkout ${ref}`, {
        cwd: checkoutPath,
        encoding: 'utf8',
        stdio: 'pipe',
    });
}

/**
 * Get the current HEAD commit SHA of a git checkout.
 *
 * @param checkoutPath - Absolute path to the git repository.
 * @returns The full 40-character commit SHA.
 */
export function getCurrentCommit(checkoutPath: string): string {
    return execSync('git rev-parse HEAD', {
        cwd: checkoutPath,
        encoding: 'utf8',
    }).trim();
}
