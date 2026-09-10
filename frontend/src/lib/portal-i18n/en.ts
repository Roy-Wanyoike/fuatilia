/**
 * App i18n — English catalog (issues #149 + #180). THE source of truth for
 * every human string in the app's three route groups: the payer portal
 * (issue #149), the collector dashboard and the auth surfaces (issue #180).
 * `sw.ts` is type-checked against the shape of this object and the key union
 * in `dictionary.ts` is DERIVED from it, so a string added here immediately
 * surfaces as (a) a missing-key error in `sw` and (b) a key the views can
 * adopt — key derivation from usage, both directions.
 *
 * Sections are grouped by SURFACE then view: the #149 portal sections come
 * first, then the #180 `dashboard` + `auth` sections. Wire enum values that
 * the operator console renders verbatim (machine-facing diagnostic badges)
 * are NOT adopted; unions with human label maps (case status, action types)
 * live under `dashboard.collections.*Labels` and are bound in the views via
 * `Record<EnumUnion, LocaleKey>` maps.
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
        sourceEmptyDescription: 'No payments have been received on your account so far.',
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

  // =========================================================================
  // (dashboard) — the collector console (issue #180). en values are the
  // console's existing copy, byte-identical; component tests pin many of
  // them, so any edit here is a visible copy change, never a silent one.
  // =========================================================================
  dashboard: {
    shell: {
      skipToContent: 'Skip to content',
      brandTagline: 'AR & collections · Kenya',
      navAriaLabel: 'Primary',
      /** Badge for a section whose backend capability is not mounted yet. */
      planned: 'planned',
      permissionsNote:
        'Permissions are enforced by the API (deny-by-default). Refusals surface in-page with their contract code.',
      /** Sr-only prefix before the health state (trailing space is deliberate). */
      apiHealthSrPrefix: 'API health: ',
      health: {
        checking: 'checking…',
        reachable: 'reachable',
        unreachable: 'unreachable',
      },
      /** Nav labels, bound in the shell via Record<href, LocaleKey> maps. */
      nav: {
        overview: { label: 'Overview', description: 'Headline money positions' },
        collections: { label: 'Collections', description: 'Command Center + cases' },
        payments: { label: 'Payments', description: 'Fund truth, Daraja intake' },
        reconciliation: { label: 'Reconciliation', description: 'Matching + unapplied cash' },
        customers: { label: 'Customers', description: 'Customer 360' },
        settings: { label: 'Settings', description: 'Team, roles, API keys' },
      },
    },

    overview: {
      title: 'Overview',
      subtitle:
        'Headline positions derived from the /v1 read models — actuals only, no predictions.',
      /** Rendered as e.g. "Overdue is unavailable" on a non-401/403 error. */
      cardUnavailable: '{card} is unavailable',
      emptyTitle: 'Nothing here yet',
      emptyDescription: 'The underlying read model returned no rows on this deployment.',
      mixedCurrencyCountOnly: 'mixed currencies — count only (R10)',
      rangeCountOnly: 'total beyond exact integer range — count only',
      cards: {
        outstanding: {
          title: 'Outstanding receivables',
          totalLabel: 'open + partially paid balance',
        },
        overdue: {
          title: 'Overdue',
          totalLabel: 'past-due balance',
        },
        unmatchedCash: {
          title: 'Unmatched cash',
          totalLabel: 'confirmed but unapplied',
        },
      },
    },

    payments: {
      title: 'Payments',
      subtitle: 'The fund-truth read model over the one Daraja intake funnel (C2B + STK).',
      ledgerTitle: 'Ledger',
      totalBadge: '· {total} total',
      tableLabel: 'Payments ledger',
      refusedTitle: 'Payments are unavailable',
      emptyTitle: 'No payments yet',
      emptyDescription: 'Money arrives through POST /v1/payments/intake — the one C2B/STK funnel.',
      page: 'page {page}',
      pageOf: 'page {page} of ≤ {pages}',
      col: {
        receipt: 'Receipt',
        channel: 'Channel',
        state: 'State',
        requested: 'Requested',
        confirmed: 'Confirmed',
        unapplied: 'Unapplied',
        initiated: 'Initiated',
      },
    },

    commandCenter: {
      title: 'Collections Command Center',
      subtitle: 'What should my collections team do right now?',
      asOf: 'derived for {day} (Africa/Nairobi)',
      refresh: 'Refresh',
      truncatedNote:
        'Large dataset: the read path stopped at the payload-conscious page cap, so totals cover the fetched rows only. Server-side aggregation is roadmap (README "Card derivations").',
      /** The CommandCard footer prefix; the derivation itself names the contract. */
      derivationLabel: 'derivation:',
      metric: {
        mixedCurrencies: 'mixed currencies — count only (R10: no cross-currency totals)',
        rangeOverflow: 'total beyond exact integer range — count only (money never rounds)',
      },
      cards: {
        expectedToday: {
          cardTitle: 'Expected collections today',
          question: 'Which balances fall due today?',
          derivation:
            'GET /v1/receivables — balance of open|partially_paid rows with dueDate = today',
          errorTitle: 'Expected collections today is unavailable',
          sourceEmptyTitle: 'No receivables on this deployment yet',
          sourceEmptyDescription:
            'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
          subsetEmptyTitle: 'Nothing falls due today',
          subsetEmptyDescription:
            'No outstanding receivable has a due date of today (Africa/Nairobi).',
          subsetEmptyHint: 'Receivables are fetched sorted by due date ascending.',
          totalLabel: 'outstanding balance due today',
        },
        overdue: {
          cardTitle: 'Overdue',
          question: 'How much money is past due, and how deep?',
          derivation:
            'GET /v1/receivables — overdue flag + aging buckets of open|partially_paid rows',
          errorTitle: 'Overdue exposure is unavailable',
          sourceEmptyTitle: 'No receivables on this deployment yet',
          sourceEmptyDescription:
            'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
          subsetEmptyTitle: 'Nothing is overdue',
          subsetEmptyDescription: "No receivable carries the lane's overdue flag.",
          totalLabel: 'overdue balance',
          bucketLabel: '{bucket}: {count}',
        },
        atRisk: {
          cardTitle: 'At-risk',
          question: 'Which balances are deep in the aging ladder?',
          derivation:
            'GET /v1/receivables — aging bucket ∈ {61-90, 90+} of open|partially_paid rows',
          errorTitle: 'At-risk exposure is unavailable',
          sourceEmptyTitle: 'No receivables on this deployment yet',
          sourceEmptyDescription:
            'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
          subsetEmptyTitle: 'Nothing is deep-aged',
          subsetEmptyDescription:
            'No receivable sits in the 61–90 or 90+ aging buckets — the at-risk definition for v1.',
          subsetEmptyHint: 'Risk-scoring engine (SPEC §25) refines this definition on the roadmap.',
          totalLabel: 'aged 61–90 / 90+ days',
        },
        promisesDue: {
          cardTitle: 'Promises due',
          question: 'Which customers have promised money, and whose follow-up is due?',
          derivation:
            "GET /v1/collections/cases — live cases with derivedStatus 'promised'; due-now = uncompleted action scheduled ≤ today",
          errorTitle: 'Promise tracking is unavailable',
          sourceEmptyTitle: 'No collections cases yet',
          sourceEmptyDescription:
            'GET /v1/collections/cases returned an empty first page — open a case to start tracking.',
          subsetEmptyTitle: 'No live promised cases',
          subsetEmptyDescription:
            'No live case (open / in_progress) currently derives the promised overlay.',
          subsetEmptyHint: 'The dedicated promise read model (amount + due date) is roadmap.',
          dueNowSuffix: 'with a follow-up due today or earlier',
        },
        missedPromises: {
          cardTitle: 'Missed promises',
          question: 'Which promised follow-ups slipped past their scheduled day?',
          derivation:
            'GET /v1/collections/cases — promised cases with an uncompleted action scheduled before today',
          errorTitle: 'Missed-promise tracking is unavailable',
          sourceEmptyTitle: 'No collections cases yet',
          sourceEmptyDescription:
            'GET /v1/collections/cases returned an empty first page — open a case to start tracking.',
          subsetEmptyTitle: 'No missed promises',
          subsetEmptyDescription:
            'No promised case carries a follow-up action still uncompleted after its scheduled day.',
        },
        unmatchedPayments: {
          cardTitle: 'Unmatched payments',
          question: 'Whose cash landed but is not applied to an invoice yet?',
          derivation:
            'GET /v1/payments — confirmed ≠ null and unapplied > 0; total = Σ unapplied',
          errorTitle: 'Unmatched-payment tracking is unavailable',
          sourceEmptyTitle: 'No payments on this deployment yet',
          sourceEmptyDescription:
            'The /v1/payments read model returned an empty first page. Money arrives through the Daraja intake funnel.',
          subsetEmptyTitle: 'No unapplied confirmed cash',
          subsetEmptyDescription:
            'Every confirmed payment is fully allocated — nothing is waiting to be matched.',
          totalLabel: 'confirmed but unapplied',
        },
        opportunities: {
          cardTitle: 'High-value opportunities',
          question: 'Where is the biggest collectable money right now?',
          derivation:
            'GET /v1/receivables — top 5 open|partially_paid rows ranked by balance (integer minor units)',
          errorTitle: 'High-value opportunities are unavailable',
          sourceEmptyTitle: 'No receivables on this deployment yet',
          sourceEmptyDescription:
            'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
          subsetEmptyTitle: 'No outstanding balances to chase',
          subsetEmptyDescription: 'No receivable is in an outstanding state (open / partially_paid).',
          tableLabel: 'High-value opportunities',
          overdueBadge: 'overdue',
          footerTotal: 'Top {count} by outstanding balance — total book {book}',
          bookCountOnly: 'spans currencies (count only)',
          col: {
            customer: 'Customer',
            balance: 'Balance',
            aging: 'Aging',
          },
        },
      },
    },

    collections: {
      /** Human labels for the case state machine (bound via Record maps). */
      statusLabels: {
        open: 'Open',
        in_progress: 'In progress',
        resolved: 'Resolved',
        closed_inactive: 'Closed (inactive)',
      },
      /** Human labels for case action types (bound via Record maps). */
      actionTypeLabels: {
        call: 'Call',
        sms: 'SMS',
        whatsapp: 'WhatsApp',
        letter: 'Letter',
        fieldVisit: 'Field visit',
        escalation: 'Escalation',
      },

      workspace: {
        title: 'Collections workspace',
        subtitle: "Cases, their state machine, and the collector's action ladder.",
      },

      list: {
        title: 'Cases',
        description:
          'GET /v1/collections/cases — the org-scoped case read model, cursor-paginated. Rows are sealed logs: work happens in the case detail.',
        sortLabel: 'Sort',
        sortDirectionLabel: 'Sort direction',
        refresh: 'Refresh',
        refusedTitle: "Couldn't load cases",
        emptyTitle: 'No collections cases yet',
        emptyDescription:
          'The /v1/collections/cases read model returned an empty first page for your org.',
        emptyHint: 'Open a case below over one or more receivables to start tracking collections.',
        shownOfTotal: '{shown} of {total} case(s) shown',
        shownCount: '{shown} case(s) shown',
        loadMore: 'Load more',
        loading: 'Loading…',
        col: {
          case: 'Case',
          priority: 'Priority',
          status: 'Status',
          derived: 'Derived',
          actions: 'Actions',
          opened: 'Opened',
        },
      },

      open: {
        title: 'Open a case',
        description:
          'POST /v1/collections/cases — at most ONE open case per receivable (R8); the wire refuses duplicates with 409 CASE_ALREADY_OPEN.',
        toggle: 'Open case…',
        hide: 'Hide',
        success: 'Case {caseNumber} opened.',
        workTheCase: 'Work the case →',
        refusedTitle: "Couldn't open the case",
        receivablesLegend: 'Receivables to cover',
        pickerRefusedTitle: "Couldn't load receivables for picking",
        pickerEmpty:
          'No receivables on this deployment yet — paste ids below once invoices exist.',
        collectorIdLabel: 'Collector id',
        collectorIdPlaceholder: 'UUID of the assigned collector',
        priorityLabel: 'Priority',
        additionalIdsLabel: 'Additional receivable ids (optional)',
        additionalIdsPlaceholder: 'Comma- or space-separated UUIDs',
        localErrorNoIds: 'Select or paste at least one receivable id.',
        localErrorCollector: 'A collector id is required.',
        submit: 'Open case',
        submitting: 'Opening…',
        reset: 'Reset',
      },

      detail: {
        backToCases: '← Back to cases',
        heading: 'Case {caseNumber}',
        headingUnnamed: 'Case',
        refusedTitle: "Couldn't load the case",
      },

      summary: {
        collectorPrefix: '· collector',
        opened: 'Opened',
        openedBy: 'Opened by',
        closed: 'Closed',
        closedBy: 'Closed by',
        coveredReceivables: 'Covered receivables',
        receivablesRefusedTitle: "Couldn't load the covered receivables",
        overdueSuffix: '· overdue',
        outstandingTotal: 'Outstanding: {total}',
        noSingleTotal:
          'No single total: the covered balances do not share one currency (or exceed a safe sum) — per-receivable balances above are the truth.',
      },

      log: {
        title: 'The sealed log',
        description: 'Append-only, as the wire returned it — actions, transitions, priority changes.',
        sealedNote:
          'This case is {status} — its log is sealed and the wire refuses further writes with 409 CASE_CLOSED.',
        actionsTitle: 'Actions ({count})',
        actionsEmpty: 'No actions recorded yet.',
        awaitingCompletion: 'awaiting completion',
        completedAt: 'completed {at}',
        historyTitle: 'Lifecycle history ({count})',
        historyEmpty: 'No transitions recorded yet.',
        historyFromTo: '{from} → {to}',
        historyReason: '— “{reason}”',
        historyMeta: 'at {at} by {actor}',
        priorityTitle: 'Priority changes ({count})',
        priorityEmpty: 'No escalations recorded yet.',
        col: {
          type: 'Type',
          scheduled: 'Scheduled',
          source: 'Source',
          consent: 'Consent',
          outcome: 'Outcome',
          state: 'State',
        },
      },

      transition: {
        title: 'Lifecycle',
        sealedDescription:
          'Legal edges only: open → in_progress, in_progress → resolved | closed_inactive.',
        sealedNote:
          'This case is {status} — a terminal state takes no edges, so there is nothing to transition.',
        description:
          'POST …/transitions — move along a legal edge. The decision, its reason and actor are appended to the case history.',
        success: 'Case moved to {to}.',
        refusedTitle: "Couldn't move the case",
        moveToLegend: 'Move to',
        reasonLabel: 'Transition reason (appended to the case history)',
        reasonPlaceholder: 'Why the case is moving (recorded in the history log)',
        reasonRequired: 'A reason is required — the transition is recorded in the case history.',
        submit: 'Move to {to}',
        submitting: 'Moving…',
      },

      escalation: {
        title: 'Escalation',
        sealedDescription:
          'Strictly upward: low < normal < high < urgent — the wire refuses sidesteps and downgrades with 400 CASE_ESCALATION_INVALID.',
        sealedNote:
          'This case is {priority} — already at the top of the ladder, with nothing to escalate to.',
        description:
          'POST …/escalations — strictly upward from {from}. Every bump is appended to priorityChanges.',
        success: 'Case escalated to {to}.',
        refusedTitle: "Couldn't escalate the case",
        escalateToLegend: 'Escalate to',
        reasonLabel: 'Escalation reason',
        reasonPlaceholder: 'e.g. 60+ days overdue and site access at risk',
        reasonRequired: 'A reason is required — the bump is recorded in the case log.',
        submit: 'Escalate to {to}',
        submitting: 'Escalating…',
      },

      record: {
        title: 'Record an action',
        sealedDescription: "POST …/actions — append to the case's action log.",
        sealedNote:
          'This case is {status} — its action log is sealed (the wire refuses further writes with 409 CASE_CLOSED).',
        description: 'POST …/actions — one entry per send/attempt, appended to the sealed log.',
        refusedTitle: "Couldn't record the action",
        typeLabel: 'Type',
        scheduledLabel: 'Scheduled for (Nairobi time)',
        sourceLabel: 'Source',
        consentLabel: 'Dunning consent reference (K2)',
        consentPlaceholder: 'Active consent reference for automated outbound dunning',
        consentHelp:
          'Automated sms/whatsapp dunning requires an active consent reference — without one the wire refuses 403 DUNNING_CONSENT_REQUIRED and nothing is sent.',
        outcomeLabel: 'Outcome (optional — usually stamped when completing)',
        scheduleRequired: 'Enter a valid schedule date and time.',
        consentRequired:
          'An automated outbound send requires a dunning consent reference (K2) — nothing may be sent without one.',
        success: '{type} recorded — scheduled for {when}.',
        submit: 'Record action',
        submitting: 'Recording…',
      },

      complete: {
        title: 'Complete an action',
        sealedDescription: 'POST …/actions/:actionId/completions — stamp the outcome, exactly once.',
        description: 'POST …/actions/:actionId/completions — the outcome is stamped exactly once.',
        emptyNoActions:
          'No actions recorded on this case yet — record one above, then complete it with its outcome.',
        emptyAllCompleted: 'Every recorded action is already completed — nothing awaits an outcome.',
        success: 'Action completed with outcome “{outcome}”.',
        refusedTitle: "Couldn't complete the action",
        selectLabel: 'Action awaiting completion',
        optionLabel: '{type} — scheduled {when}',
        outcomeLabel: 'Outcome',
        outcomePlaceholder:
          'What actually happened, e.g. spoke to site foreman — promised part payment',
        outcomeRequired:
          'An outcome is required — a completion stamps what actually happened.',
        submit: 'Complete action',
        submitting: 'Completing…',
      },
    },

    customers: {
      directory: {
        title: 'Customers',
        subtitle:
          'Customer 360. Identities are derived from the receivable and payment read models — the /v1 contract mounts no customer directory yet.',
        regionLabel: 'Customer directory',
        cardTitle: 'Directory',
        derivedCount: '· {count} derived',
        refusedTitle: 'The customer directory is unavailable',
        emptyTitle: 'No customer activity yet',
        emptyDescription:
          'Neither the receivable nor the payment read model returned rows, so no customer identities can be derived yet.',
        emptyHint: 'Rows arrive through the invoicing flow and the Daraja intake funnel.',
        truncatedNote:
          'Large dataset: the read path stopped at the payload-conscious page cap, so this directory covers the fetched rows only.',
        footer:
          'derivation: GET /v1/receivables + GET /v1/payments — distinct customerId (payments without a customerId are unattributable)',
        mixedCurrencyCountOnly: 'mixed currencies — count only (R10)',
        rangeCountOnly: 'beyond exact integer range — count only',
        overdueCount: '{count} overdue',
        viewLink: 'View',
        viewLinkSrOnly: 'customer {id}',
        open360SrOnly: 'Open the 360 view',
        col: {
          customer: 'Customer',
          outstanding: 'Outstanding',
          overdue: 'Overdue',
          receivables: 'Receivables',
          lastActivity: 'Last activity',
        },
      },

      c360: {
        title: 'Customer 360',
        subtitle:
          'Receivables, payments, cases and communications attributed to this customer — fed only by the mounted /v1 read models.',
        allCustomers: 'All customers',
        noActivityTitle: 'No /v1 activity is attributable to this customer id',
        noActivityDescription:
          'No receivable or payment row carries this customerId, and cases can only be attributed through receivables. The id is either unknown to this deployment or has no activity yet.',
        noActivityHint:
          'The /v1 contract mounts no customer directory, so an unknown id cannot be distinguished from an inactive one — nothing is fabricated either way.',
        truncatedNote:
          'Large dataset: the read path stopped at the payload-conscious page cap, so this view covers the fetched rows only.',
        stats: {
          outstanding: 'outstanding',
          overdue: 'overdue',
          confirmed: 'confirmed',
          heldOnAccount: 'held on account',
        },
        statFallbacks: {
          noRows: '· no rows yet',
          mixed: '· mixed currencies — count only (R10: no cross-currency totals)',
          range: '· beyond exact integer range — count only',
        },
        agingTitle: 'Aging buckets (outstanding balance)',
        agingMixed: 'mixed currencies (R10)',
        agingRange: 'beyond exact range',
        terminalOne: '{count} further receivable settled, written off or otherwise closed.',
        terminalMany: '{count} further receivables settled, written off or otherwise closed.',
        overdueBadge: 'overdue',
        paymentRow: {
          requestedLabel: 'requested',
          confirmedLabel: 'confirmed',
          unappliedSuffix: '{amount} unapplied',
          initiatedPrefix: 'initiated {at}',
          failureCodePrefix: 'failure code:',
          reversalReasonPrefix: 'reversal reason:',
          appliedTo: 'applied to receivable {id}',
          refunded: 'refunded',
        },
        promises: {
          title: 'Promises',
          empty: 'No live promised cases.',
          missed: 'missed',
          dueNow: 'due now',
          scheduled: 'scheduled',
          noPendingFollowUp: 'no pending follow-up',
          nextFollowUp: 'next follow-up {at}',
        },
        openCaseCountSuffix: 'open ({total} total incl. resolved/closed)',
        commsRow: {
          pending: 'pending',
          completed: 'completed',
          scheduledAt: 'scheduled {at}',
          completedAt: 'completed {at}',
          consentRefPrefix: 'consent ref:',
        },
        receivables: {
          cardTitle: 'Receivables & aging',
          question: 'What does this customer owe, and how deep is it aged?',
          derivation:
            'GET /v1/receivables — customerId filter; aging over open|partially_paid rows (settled money is never aged)',
          errorTitle: 'Receivables are unavailable',
          emptyDeploymentTitle: 'No receivables on this deployment yet',
          emptyDeploymentDescription:
            'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
          emptyCustomerTitle: 'No receivables carry this customer id',
          emptyCustomerDescription:
            'The receivable read model has rows, but none of the fetched pages attributes this customerId.',
          col: {
            invoice: 'Invoice',
            state: 'State',
            balance: 'Balance',
            due: 'Due',
            aging: 'Aging',
          },
        },
        payments: {
          cardTitle: 'Payment history & allocations',
          question: 'What money moved, and where was it applied?',
          derivation:
            'GET /v1/payments — customerId filter; allocations flattened from allocations[] rows',
          errorTitle: 'Payment history is unavailable',
          emptyDeploymentTitle: 'No payments on this deployment yet',
          emptyDeploymentDescription:
            'The /v1/payments read model returned an empty first page. Money arrives through the Daraja intake funnel.',
          emptyCustomerTitle: 'No payments carry this customer id',
          emptyCustomerDescription:
            'The payment read model has rows, but none of the fetched pages attributes this customerId (payments without a customerId are unattributable).',
        },
        cases: {
          cardTitle: 'Collections cases & promises',
          question: 'Is this customer in active collections, and what did they promise?',
          derivation:
            'GET /v1/collections/cases — attributed via receivableIds; promises from the derivedStatus overlay + earliest uncompleted action',
          errorTitle: 'Collections cases are unavailable',
          attributionErrorTitle: 'Case attribution is unavailable',
          emptyDeploymentTitle: 'No collections cases yet',
          emptyDeploymentDescription:
            'GET /v1/collections/cases returned an empty first page — open a case to start tracking.',
          emptyCustomerTitle: "No cases touch this customer's receivables",
          emptyCustomerDescription:
            'Cases link to customers only through receivableIds; none of the fetched cases covers this customer\u2019s receivables.',
          col: {
            case: 'Case',
            priority: 'Priority',
            status: 'Status',
            actions: 'Actions',
            opened: 'Opened',
          },
        },
        comms: {
          cardTitle: 'Communications timeline',
          question: 'What has been said, sent and scheduled with this customer?',
          derivation:
            'case actions of attributed cases — GET /v1/collections/cases (actions[]; no dedicated comms endpoint is mounted)',
          errorTitle: 'The communications timeline is unavailable',
          attributionErrorTitle: 'Comms attribution is unavailable',
          emptyDeploymentTitle: 'No collections cases yet',
          emptyDeploymentDescription:
            'The communications log derives from case actions, and the case read model is empty.',
          emptyCustomerTitle: 'No case actions for this customer yet',
          emptyCustomerDescription:
            "The customer's cases carry no recorded actions (calls, messages, letters, visits, escalations) yet.",
        },
      },
    },

    reconciliation: {
      title: 'Reconciliation',
      bodyPrefix:
        "Matching (Matched / Suggested / Unmatched / Duplicates / Amount mismatch) needs the reconciliation engine's read model on /v1. The contract's mounted capabilities today are",
      /** Wire capability names stay verbatim — they name the contract. */
      capabilities: 'auth, collections, payments, receivables',
      bodySuffix: '.',
      emptyTitle: 'No reconciliation surface is mounted on /v1 yet',
      emptyDescription:
        'api/openapi/fuatilia.v1.yaml documents 22 operations over health, auth admin, receivables, payments and collections cases — none of them reconciliation matches.',
      emptyHint: 'Track the payments-lane follow-up that mounts the reconciliation read model.',
    },

    settings: {
      title: 'Settings',
      bodyPrefix:
        'The /v1 contract mounts auth-admin mutations (create user, grant/revoke role, issue/revoke API key, revoke session) behind',
      /** The permission scope stays verbatim — it names the contract. */
      scope: 'admin:manage-users',
      bodySuffix: ', but no list/read operations to render management tables from.',
      emptyTitle: 'Settings management arrives with the auth-admin read models',
      emptyDescription:
        'Until /v1 exposes users/grants/keys read endpoints, administration happens through the API directly; the console renders no substitute data.',
      emptyHint:
        'The actions lane will layer react-hook-form + policy-gated mutations onto this page.',
    },
  },

  // =========================================================================
  // (auth) — the credential surfaces (issue #180).
  // =========================================================================
  auth: {
    meta: {
      /** Browser-tab title for the auth route group. */
      title: 'Fuatilia — Sign in',
      description: 'Collector sign-in for the Fuatilia collections console.',
    },

    signIn: {
      title: 'Sign in to Fuatilia',
      intro:
        'The collections console for your team. Paste the session credential your Fuatilia administrator issued to begin.',
      credentialLabel: 'Session credential',
      credentialHelp:
        'The credential is validated against the live API once, then held in an HTTP-only, SameSite=Strict cookie and relayed to the API server-side. It is never placed in a URL, never stored in your browser, and never readable by scripts on this page.',
      emptyCredentialError: 'Paste the session credential your administrator issued.',
      submit: 'Open the console',
      submitting: 'Validating…',
      refusedTitle: 'This session credential was not accepted',
      refusedDescription:
        'Check the credential and try again, or ask your Fuatilia administrator for a fresh session.',
      unreachableTitle: 'The API could not be reached',
      unreachableBody:
        'The credential could not be validated, so nothing was unlocked. Try again in a moment — no access is granted on an unverifiable credential.',
      seamNoteTitle: 'How sign-in works today:',
      seamNoteBody:
        'the mounted /v1 contract issues sessions through the auth admin lane, not through a username/password form — so this screen accepts the session credential itself and proves it against a live protected operation before the console opens. Nothing here is simulated.',
    },

    signOut: {
      title: 'Sign out of Fuatilia',
      done: 'You are signed out. The session cookie has been cleared on this browser.',
      signInAgain: 'Sign in again',
      failed: 'The sign-out request did not complete. The session cookie may still be present — try again.',
      help: 'Signing out expires the HTTP-only session cookie on this browser. The credential itself is never readable by this page.',
      submit: 'Sign out',
      submitting: 'Signing out…',
    },

    signInRequired: {
      title: 'Sign in to Fuatilia',
      bodyLeadIn: 'This console reads its bearer credential from an HTTP-only session cookie (',
      bodyRelay: '), which the API relays as ',
      bodyRest:
        '. The cookie is never readable from browser JavaScript and is never stored in localStorage.',
      seamStatusLabel: 'Seam status:',
      seamNote:
        "the mounted /v1 contract (api/openapi/fuatilia.v1.yaml) exposes session revocation but not session issuance — the login operation lands with the backend auth lane. Until then the gate enforces the cookie contract's presence check only, and no dashboard data can be fabricated in its place.",
      devNote:
        'In development, seed the cookie with a real auth-lane session id to exercise the read path; see frontend/README.md "Auth at the seam".',
    },
  },
} as const;
