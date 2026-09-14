/**
 * GitHub issue labels shared by both ends of the mirror pipeline.
 *
 * The intake and synchronization adapters mint exactly these strings on the issues they create in
 * the private lab, and the automatic upstream sync matches them back when it selects mirrored
 * issues. Producer and consumer used to spell them independently, so renaming a label on one side
 * pushed every mirrored issue silently out of scope instead of failing loudly. Values are the exact
 * upstream label text, including the `T: ` / `N: ` prefixes and the original capitalization GitHub
 * stores.
 */
export const IssueLabel = {
    /**
     * Advertising that the reporter's filters failed to block.
     */
    TypeAds: 'T: Ads',

    /**
     * A site script that detects or retaliates against ad blocking.
     */
    TypeAntiAdblockScript: 'T: Anti Adblock Script',

    /**
     * A false positive: filters broke page content that should have been left alone.
     */
    TypeIncorrectBlocking: 'T: Incorrect Blocking',

    /**
     * The report concerns the AdGuard Browser Extension, the only product in fix-agent scope.
     */
    ProductBrowserExtension: 'N: AdGuard Browser Extension',

    /**
     * The report concerns AdGuard for Windows.
     */
    ProductWindows: 'N: AdGuard for Windows',

    /**
     * The report concerns AdGuard for Mac.
     */
    ProductMac: 'N: AdGuard for Mac',

    /**
     * The report concerns AdGuard for Android.
     */
    ProductAndroid: 'N: AdGuard for Android',

    /**
     * The report concerns AdGuard for iOS.
     */
    ProductIos: 'N: AdGuard for iOS',

    /**
     * The report concerns AdGuard CLI.
     */
    ProductCli: 'N: AdGuard CLI',
} as const;

/**
 * Every IssueLabel value, for schemas and exhaustive listings.
 */
export const ISSUE_LABEL_VALUES = Object.values(IssueLabel);

/**
 * IssueLabel value.
 */
export type IssueLabel = (typeof IssueLabel)[keyof typeof IssueLabel];
