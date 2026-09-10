import type { Dictionary } from './dictionary';

/**
 * Portal i18n — Kiswahili catalog (issue #149). COMPLETE by construction:
 * `satisfies Dictionary` makes every missing / extra / mistyped key a tsc
 * error, and the catalog parity test re-asserts en ≡ sw at runtime. Kenya
 * differentiator: the payer portal speaks the payer's language.
 */
export const sw = {
  meta: {
    title: 'Fuatilia — Portal ya Malipa',
    description: 'Lango la kujihudumia la malipa: mabaki, ankara na taarifa za malipo.',
  },

  language: {
    label: 'Lugha',
    /** Endonyms hazitaswi kutafsiriwa — lugha huita jina lake. */
    english: 'English',
    kiswahili: 'Kiswahili',
  },

  common: {
    brand: 'Fuatilia',
    previous: 'Iliyotangulia',
    next: 'Ifuatayo',
    codeLabel: 'msimbo:',
    requestIdLabel: 'kitambulisho cha ombi:',
    returnToGate: 'Rudi kwenye lango la nambari ya ufikiaji',
    noInvoicesTitle: 'Hakuna ankara kwenye akaunti bado',
    noInvoicesDescription: 'Hakuna kilichobiliwa kwenye akaunti yako hadi sasa.',
    noPaymentsTitle: 'Hakuna malipo yaliyorekodiwa bado',
    refusedBillingDescription: 'Kipindi hiki cha portal kimekataliwa kupata data yako ya bili.',
    refusedPaymentsDescription: 'Kipindi hiki cha portal kimekataliwa kupata data yako ya malipo.',
  },

  gate: {
    title: 'Fuatilia — portal ya malipa',
    intro:
      'Ona unachodaiwa, ulicholipa, na mahali pesa yako ilipotumika. Weka nambari ya ufikiaji uliyopokelewa ili kuanza.',
    codeLabel: 'Nambari ya ufikiaji ya portal',
    codeHelp:
      'Nambari inathibitishwa dhidi ya API hai mara moja, kisha inashikiliwa kwenye cookie ya HTTP-only, SameSite=Strict na kupelekwa kwa API upande wa seva. Haiwekwi kwenye URL, haihifadhiwi kwenye kivinjari chako, na haisomeki na maandishi ya programu kwenye ukurasa huu.',
    submit: 'Fungua akaunti yangu',
    submitting: 'Inathibitisha…',
    emptyCodeError: 'Weka nambari ya ufikiaji uliyopokelewa.',
    refusedTitle: 'Nambari hii ya ufikiaji haikukubaliwa',
    refusedDescription:
      'Angalia nambari kisha ujaribu tena, au omba nambari mpya ya ufikiaji kutoka kwa mtoa bili.',
    unreachableTitle: 'API haikufikiwa',
    unreachableBody:
      'Nambari ya ufikiaji haikuthibitishwa, hivyo hakuna kilichofunguliwa. Jaribu tena baada ya kidogo — hakuna ufikiaji unaotolewa kwa nambari isiyothibitika.',
  },

  shell: {
    skipToContent: 'Ruka hadi maudhui',
    payerPortal: 'portal ya malipa',
    signOut: 'Toka',
    signingOut: 'Inatoka…',
    navAriaLabel: 'Menyu ya portal',
    nav: {
      balance: 'Salio',
      invoices: 'Ankara',
      statement: 'Taarifa',
    },
  },

  balance: {
    title: 'Salio lako',
    subtitle:
      'Unachodaiwa, kilichochelewa, na malipo yaliyoshikiliwa kwenye akaunti yako — data halisi kutoka kwenye mfumo wa bili, hakuna kilichokadiriwa.',
    cardUnavailable: '{card} haipatikani',
    mixedCurrencyCountOnly: 'sarafu mchanganyiko kwenye akaunti hii — idadi tu (R10)',
    rangeCountOnly: 'jumla imezidi upeo sahihi wa namba — idadi tu',
    cards: {
      outstanding: {
        title: 'Zilizobaki kulipwa',
        caption: 'zilizobaki kulipwa kwenye ankara zilizo wazi',
        refusedTitle: 'Salio lako halipatikani',
        emptyTitle: 'Hakuna deni lililobaki',
        emptyDescription: 'Ankara zote kwenye akaunti yako zimelipwa kikamilifu.',
      },
      overdue: {
        title: 'Zilizochelewa',
        caption: 'zimepita tarehe ya malipo',
        refusedTitle: 'Deni lako lilochelewa halipatikani',
        emptyTitle: 'Hakuna kilichochelewa',
        emptyDescription: 'Ankara zote ziko kwenye ratiba.',
      },
      heldOnAccount: {
        title: 'Zilizoshikiliwa kwenye akaunti',
        caption: 'zimelipwa lakini hazijatumika kwenye ankara',
        refusedTitle: 'Malipo yako hayapatikani',
        sourceEmptyDescription: 'Hakuna malipo yaliyopokelewa kwenye akaunti yako hadi sasa.',
        emptyTitle: 'Hakuna kilichoshikiliwa kwenye akaunti',
        emptyDescription: 'Malipo yote yaliyopokelewa yametumika kwenye ankara zako.',
      },
    },
  },

  invoices: {
    title: 'Ankara zako',
    subtitle: 'Kila ankara kwenye akaunti yako na hali yake, salio na umri wa deni.',
    regionLabel: 'Ankara',
    cardTitle: 'Ankara',
    totalBadge: '· jumla {total}',
    col: {
      invoice: 'Ankara',
      state: 'Hali',
      balance: 'Salio',
      due: 'Muda wa kulipa',
      aging: 'Umri wa deni',
    },
    overdueBadge: 'imechelewa',
    dayPastDue: 'imechelewa siku {days}',
    daysPastDue: 'imechelewa siku {days}',
    notPastDue: 'haijapita muda',
    duePrefix: 'muda wa kulipa',
    refusedTitle: 'Ankara zako hazipatikani',
    errorTitle: 'Ankara hazipatikani kwa sasa',
    page: 'ukurasa {page}',
    pageOf: 'ukurasa {page} wa ≤ {pages}',
  },

  statement: {
    title: 'Taarifa yako',
    subtitle:
      'Kila uthibitisho, matumizi, marejesho, kurejeshwa nyuma na makosa kwenye akaunti yako — mapya kwanza, kutoka kwenye leja ya malipo.',
    regionLabel: 'Shughuli za taarifa',
    cardTitle: 'Shughuli',
    refusedTitle: 'Taarifa yako haipatikani',
    errorTitle: 'Taarifa haipatikani kwa sasa',
    emptyDescription:
      'Malipo yanapopokelewa kwenye akaunti yako yataonekana hapa pamoja na mahali yalipotumika.',
    truncatedNote:
      'Inaonyesha malipo ya karibuni tu — kikomo cha ukurasa kimefikiwa, hivyo shughuli za zamani hazijaorodheshwa.',
    noFundsMoved: 'hakuna fedha zilizohamishwa',
    attempted: 'jaribio',
    kinds: {
      confirmation: 'malipo yamethibitishwa',
      allocation: 'yametumika kwenye ankara',
      refund: 'marejesho',
      reversal: 'yamerejeshwa nyuma',
      failure: 'malipo yameshindikana',
    },
  },

  states: {
    draft: 'Rasimu',
    open: 'Haijalipwa',
    partially_paid: 'Imelipwa Sehemu',
    settled: 'Imelipwa',
    recovered: 'Imerejeshwa',
    written_off: 'Imeandikwa Hasara',
    uncollectible: 'Haiwezi Kukusanywa',
    voided: 'Imefutwa',
  },
} satisfies Dictionary;
