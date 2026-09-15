/**
 * The placement a run instruction declared, rendered for one run.
 *
 * The instruction owns the declaration ({@link InstructionPlacement} in
 * `src/knowledge/instruction-placement.ts`); this is what it renders to for this run — the exact
 * file the rule goes into and the exact comment line that precedes it. Both the placement resolver
 * and the repository-edit planner read it, so it lives in the shared vocabulary rather than in
 * either of them.
 */

/**
 * One run's declared placement: where the rule goes, and what is written above it.
 */
export interface DeclaredPlacement {
    /**
     * Checkout-relative file the instruction declared, with its `{{year}}` rendered.
     */
    filePath: string;

    /**
     * Comment line written immediately before the rule, with its `{{issueUrl}}` rendered; absent
     * when the declaration asks for no comment.
     */
    commentLine?: string;
}
