/**
 * How a planned rule insertion chose its in-file position. Recorded on the candidate so the
 * proposed comment and the report page can state where the rule belongs and why, from host facts
 * rather than model prose.
 */
export const PlacementBasis = {
    /**
     * The target file already holds rules for the candidate's domain; the rule joins them.
     */
    DomainBlock: 'domain_block',

    /**
     * The file ends with a named section; the rule is anchored at the end of the regular rules,
     * before that section's footer or banner.
     */
    TerminalSection: 'terminal_section',

    /**
     * No safer anchor exists; the rule is appended at the end of the file.
     */
    AppendEof: 'append_eof',
} as const;

/**
 * Every PlacementBasis value, for schemas and exhaustive listings.
 */
export const PLACEMENT_BASIS_VALUES = Object.values(PlacementBasis);

/**
 * PlacementBasis value.
 */
export type PlacementBasis = (typeof PlacementBasis)[keyof typeof PlacementBasis];
