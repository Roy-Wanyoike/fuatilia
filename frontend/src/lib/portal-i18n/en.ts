/**
 * Portal i18n — English catalog (issue #149). THE source of truth for the
 * payer portal's human strings: every key used by a (portal) view must live
 * here first. `sw.ts` is type-checked against the shape of this object and
 * the key union in `keys.ts` is DERIVED from it, so a string added here
 * immediately surfaces as (a) a missing-key error in `sw` and (b) a key the
 * views can adopt — key derivation from usage, both directions.
 *
 * Placeholders use `{name}` tokens and are filled by `translate()`; a
 * missing variable is a runtime refusal, never a silent "undefined".
 */
export const en = {
  meta: {
    /** Browser-tab title for the portal route group. */
    title: 'Fuatilia — Payer portal',
    description: 'Tokenized self-service portal: balances, invoices and payment statements.',
  },

  language: {
    label: 'Language',
    /** Language endonyms are NOT translated — they name themselves. */
    english: 'English',
    kiswahili: 'Kiswahili',
  },

  common: {
    brand: 'Fuatilia',
    previous: 'Previous',
    next: 'Next',
    /** Technical labels for the contract refusal envelope (kept terse). */
    codeLabel: 'code:',
    requestIdLabel: 'requestId:',
    returnToGate: 'Return to access-code gate',
    noInvoicesTitle: 'No invoices on file yet',
    noInvoicesDescription: 'Nothing has been billed to your account so far.',
    noPaymentsTitle: 'No payments on file yet',
    refusedBillingDescription: 'This portal session was refused access to your billing data.',
    refusedPaymentsDescription: 'This portal session was refused access to your payment data.',
  },

  gate: {
    title: 'Fuatilia payer portal',
    intro:
      'See what you owe, what you have paid, and where your money was applied. Paste the access code you received to begin.',
    codeLabel: 'Portal access code',
    codeHelp:
      'The code is validated against the live API once, then held in an HTTP-only, SameSite=Strict cookie and relayed to the API server-side. It is never placed in a URL, never stored in your browser, and never readable by scripts on this page.',
    submit: 'Open my account',
    submitting: 'Validating…',
    emptyCodeError: 'Enter the access code you received.',
    refusedTitle: 'This access code was not accepted',
    refusedDescription:
      'Check the code and try again, or request a new portal access code from the biller.',
    unreachableTitle: 'The API could not be reached',
    unreachableBody:
      'The access code could not be validated, so nothing was unlocked. Try again in a moment — no access is granted on an unverifiable code.',
  },

  shell: {
    skipToContent: 'Skip to content',
    payerPortal: 'payer portal',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    navAriaLabel: 'Portal',
    nav: {
      balance: 'Balance',
      invoices: 'Invoices',
      statement: 'Statement',
    },
  },

  balance: {
    title: 'Your balance',
    subtitle:
      'What you owe, what is overdue, and payments held on your account — actuals from the billing system, nothing estimated.',
    /** Rendered as e.g. "Outstanding is unavailable" on a non-401/403 error. */
    cardUnavailable: '{card} is unavailable',
    mixedCurrencyCountOnly: 'mixed currencies on this account — count only (R10)',
    rangeCountOnly: 'total beyond exact integer range — count only',
    cards: {
      outstanding: {
        title: 'Outstanding',
        caption: 'left to pay across open invoices',
        refusedTitle: 'Your balance is not available',
        emptyTitle: 'Nothing outstanding',
        emptyDescription: 'Every invoice on your account is settled.',
      },
      overdue: {
        title: 'Overdue',
        caption: 'past the due date',
        refusedTitle: 'Your overdue position is not available',
        emptyTitle: 'Nothing overdue',
        emptyDescription: 'All your invoices are on schedule.',
      },
      heldOnAccount: {
        title: 'Held on account',
        caption: 'paid but not yet applied to an invoice',
        refusedTitle: 'Your payments are not available',
        emptyTitle: 'Nothing held on account',
        emptyDescription: 'Every payment received has been applied to your invoices.',
      },
    },
  },

  invoices: {
    title: 'Your invoices',
    subtitle: 'Every invoice on your account with its state, balance and aging.',
    regionLabel: 'Invoices',
    cardTitle: 'Invoices',
    totalBadge: '· {total} total',
    col: {
      invoice: 'Invoice',
      state: 'State',
      balance: 'Balance',
      due: 'Due',
      aging: 'Aging',
    },
    overdueBadge: 'overdue',
    dayPastDue: '{days} day past due',
    daysPastDue: '{days} days past due',
    notPastDue: 'not past due',
    duePrefix: 'due',
    refusedTitle: 'Your invoices are not available',
    errorTitle: 'Invoices are unavailable',
    page: 'page {page}',
    pageOf: 'page {page} of ≤ {pages}',
  },

  statement: {
    title: 'Your statement',
    subtitle:
      'Every confirmation, application, refund, reversal and failure on your account — newest first, from the payment ledger.',
    regionLabel: 'Statement activity',
    cardTitle: 'Activity',
    refusedTitle: 'Your statement is not available',
    errorTitle: 'Your statement is unavailable',
    emptyDescription:
      'Once a payment is received on your account it will appear here with where it was applied.',
    truncatedNote:
      'Showing the most recent payments only — the page cap was reached, so older activity is not listed.',
    noFundsMoved: 'no funds moved',
    attempted: 'attempted',
    kinds: {
      confirmation: 'payment confirmed',
      allocation: 'applied to invoice',
      refund: 'refund',
      reversal: 'reversed',
      failure: 'payment failed',
    },
  },

  /** Receivable state badges — en mirrors the wire enum's plain-English form. */
  states: {
    draft: 'draft',
    open: 'open',
    partially_paid: 'partially paid',
    settled: 'settled',
    recovered: 'recovered',
    written_off: 'written off',
    uncollectible: 'uncollectible',
    voided: 'voided',
  },
} as const;
