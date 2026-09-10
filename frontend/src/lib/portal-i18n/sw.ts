import type { Dictionary } from './dictionary';

/**
 * App i18n — Kiswahili catalog (issues #149 + #180). COMPLETE by
 * construction: `satisfies Dictionary` makes every missing / extra /
 * mistyped key a tsc error, and the catalog parity test re-asserts en ≡ sw
 * at runtime. Kenya differentiator: the payer portal AND the collector
 * console speak the user's language.
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

  // =========================================================================
  // (dashboard) — koni ya mkusanyaji (issue #180).
  // =========================================================================
  dashboard: {
    overview: {
      title: 'Muhtasari',
      subtitle:
        'Nafasi kuu zinazotokana na vifaa vya kusoma vya /v1 — data halisi tu, hakuna makadirio.',
      /** Hutungwa kama k.mf. "Zilizochelewa haipatikani" kosa lisilo 401/403. */
      cardUnavailable: '{card} haipatikani',
      emptyTitle: 'Hakuna kilichopo bado',
      emptyDescription: 'Kisomeleaji cha msingi hakikurudisha safu zozote kwenye uanzishaji huu.',
      mixedCurrencyCountOnly: 'sarafu mchanganyiko — idadi tu (R10)',
      rangeCountOnly: 'jumla imezidi upeo sahihi wa namba — idadi tu',
      cards: {
        outstanding: {
          title: 'Madeni yaliyobaki',
          totalLabel: 'salio la ankara zilizo wazi na zilizolipwa sehemu',
        },
        overdue: {
          title: 'Zilizochelewa',
          totalLabel: 'salio lililochelewa',
        },
        unmatchedCash: {
          title: 'Fedha zisizolingana',
          totalLabel: 'zimethibitishwa lakini hazijatumika',
        },
      },
    },

    payments: {
      title: 'Malipo',
      subtitle: 'Mfumo wa kusoma wa ukweli wa fedha juu ya njia moja ya ingizo la Daraja (C2B + STK).',
      ledgerTitle: 'Leja',
      totalBadge: '· jumla {total}',
      tableLabel: 'Leja ya malipo',
      refusedTitle: 'Malipo hayapatikani',
      emptyTitle: 'Hakuna malipo bado',
      emptyDescription: 'Pesa huingia kupitia POST /v1/payments/intake — njia moja ya C2B/STK.',
      page: 'ukurasa {page}',
      pageOf: 'ukurasa {page} wa ≤ {pages}',
      col: {
        receipt: 'Risiti',
        channel: 'Njia',
        state: 'Hali',
        requested: 'Iliyoombwa',
        confirmed: 'Iliyothibitishwa',
        unapplied: 'Isiyotumika',
        initiated: 'Iliyoanzishwa',
      },
    },

    commandCenter: {
      title: 'Kituo cha Amri cha Makusanyi',
      subtitle: 'Timu yangu ya makusanyi ifanye nini sasa hivi?',
      asOf: 'imetokanishwa kwa {day} (Africa/Nairobi)',
      refresh: 'Onyesha upya',
      truncatedNote:
        'Data kubwa: njia ya kusoma iliacha kwenye kikomo cha ukurasa, hivyo jumla zinashughulikia safu zilizopakiwa tu. Uhalisia wa jumla upande wa seva ni mpangilio wa kazi (README "Card derivations").',
      /** Kiambishi cha mguu wa CommandCard; utokaji mwenyewe huita mkataba. */
      derivationLabel: 'utokaji:',
      metric: {
        mixedCurrencies: 'sarafu mchanganyiko — idadi tu (R10: hakuna jumla za sarafu mbalimbali)',
        rangeOverflow: 'jumla imezidi upeo sahihi wa namba — idadi tu (pesa haikaribishwi kamwe)',
      },
      cards: {
        expectedToday: {
          cardTitle: 'Makusanyo yanayotarajiwa leo',
          question: 'Mabaki gani yanaisha muda wake leo?',
          derivation:
            'GET /v1/receivables — salio la safu open|partially_paid zenye dueDate = leo',
          errorTitle: 'Makusanyo yanayotarajiwa leo hayapatikani',
          sourceEmptyTitle: 'Hakuna madeni kwenye uanzishaji huu bado',
          sourceEmptyDescription:
            'Kisomeleaji cha GET /v1/receivables kilirudisha ukurasa wa kwanza mtupu. Safu huingia kupitia mtiririko wa bili.',
          subsetEmptyTitle: 'Hakuna kinachoisha muda wake leo',
          subsetEmptyDescription:
            'Hakuna deni lisilolipwa lenye dueDate ya leo (Africa/Nairobi).',
          subsetEmptyHint: 'Madeni hupatikana yamepangwa kwa dueDate kutoka ya kwanza.',
          totalLabel: 'salio lisilolipwa linaloisha muda wake leo',
        },
        overdue: {
          cardTitle: 'Zilizochelewa',
          question: 'Pesa ngapi zimechelewa, na zimechelewa kwa kina gani?',
          derivation:
            'GET /v1/receivables — bendera ya uchelewaji + vikapu vya umri wa deni vya safu open|partially_paid',
          errorTitle: 'Ufunuo wa uchelewaji haupatikani',
          sourceEmptyTitle: 'Hakuna madeni kwenye uanzishaji huu bado',
          sourceEmptyDescription:
            'Kisomeleaji cha GET /v1/receivables kilirudisha ukurasa wa kwanza mtupu. Safu huingia kupitia mtiririko wa bili.',
          subsetEmptyTitle: 'Hakuna kilichochelewa',
          subsetEmptyDescription: 'Hakuna deni lenye bendera ya uchelewaji wa njia hii.',
          totalLabel: 'salio lililochelewa',
          bucketLabel: '{bucket}: {count}',
        },
        atRisk: {
          cardTitle: 'Hatarini',
          question: 'Mabaki gani yamekaa kina cha ngazi ya umri wa deni?',
          derivation:
            'GET /v1/receivables — kikapu cha umri wa deni ∈ {61-90, 90+} cha safu open|partially_paid',
          errorTitle: 'Ufunuo wa hatarini haupatikani',
          sourceEmptyTitle: 'Hakuna madeni kwenye uanzishaji huu bado',
          sourceEmptyDescription:
            'Kisomeleaji cha GET /v1/receivables kilirudisha ukurasa wa kwanza mtupu. Safu huingia kupitia mtiririko wa bili.',
          subsetEmptyTitle: 'Hakuna kilichokaa kina',
          subsetEmptyDescription:
            'Hakuna deni lililoko vikapuni 61–90 au 90+ vya umri wa deni — ufafanuzi wa hatarini kwa v1.',
          subsetEmptyHint: 'Injini ya kupima hatari (SPEC §25) itaboresha ufafanuzi huu kesho.',
          totalLabel: 'yaliyokaa kina siku 61–90 / 90+',
        },
        promisesDue: {
          cardTitle: 'Ahadi zinazofika muda wake',
          question: 'Wateja gani wameahidi pesa, na ufuatilio wa nani umefika?',
          derivation:
            "GET /v1/collections/cases — kesa hai zenye derivedStatus 'promised'; due-now = hatua isiyokamilika iliyopangwa ≤ leo",
          errorTitle: 'Ufuatiliaji wa ahadi haupatikani',
          sourceEmptyTitle: 'Hakuna kesa za makusanyi bado',
          sourceEmptyDescription:
            'GET /v1/collections/cases ilirudisha ukurasa wa kwanza mtupu — fungua kesa ili kuanza kufuatilia.',
          subsetEmptyTitle: 'Hakuna kesa zenye ahadi hai',
          subsetEmptyDescription:
            'Hakuna kesa hai (open / in_progress) inayotokana na overlay ya ahadi kwa sasa.',
          subsetEmptyHint: 'Kisomeleaji maalum cha ahadi (kiasi + tarehe) ni mpangilio wa kazi.',
          dueNowSuffix: 'na ufuatilio uliofika muda wake au kabla',
        },
        missedPromises: {
          cardTitle: 'Ahadi zilizopita',
          question: 'Ahadi za nini zilipita siku yake ya ufuatilio?',
          derivation:
            'GET /v1/collections/cases — kesa zenye ahadi zenye hatua isiyokamilika iliyopangwa kabla ya leo',
          errorTitle: 'Ufuatiliaji wa ahadi zilizopita haupatikani',
          sourceEmptyTitle: 'Hakuna kesa za makusanyi bado',
          sourceEmptyDescription:
            'GET /v1/collections/cases ilirudisha ukurasa wa kwanza mtupu — fungua kesa ili kuanza kufuatilia.',
          subsetEmptyTitle: 'Hakuna ahadi zilizopita',
          subsetEmptyDescription:
            'Hakuna kesa yenye ahadi inayobeba hatua ya ufuatilio isiyokamilika baada ya siku yake.',
        },
        unmatchedPayments: {
          cardTitle: 'Malipo yasiyolinganishwa',
          question: 'Pesa ya nani ilifika lakini haijatumika kwenye ankara bado?',
          derivation:
            'GET /v1/payments — confirmed ≠ null na unapplied > 0; jumla = Σ isiyotumika',
          errorTitle: 'Ufuatiliaji wa malipo yasiyolinganishwa haupatikani',
          sourceEmptyTitle: 'Hakuna malipo kwenye uanzishaji huu bado',
          sourceEmptyDescription:
            'Kisomeleaji cha GET /v1/payments kilirudisha ukurasa wa kwanza mtupu. Pesa huingia kupitia njia ya ingizo ya Daraja.',
          subsetEmptyTitle: 'Hakuna pesa iliyothibitishwa isiyotumika',
          subsetEmptyDescription:
            'Kila malipo yaliyothibitishwa yametumikwa kikamilifu — hakuna kinachosubiri kulinganishwa.',
          totalLabel: 'yaliyothibitishwa bila kutumika',
        },
        opportunities: {
          cardTitle: 'Fursa za thamani kubwa',
          question: 'Pesa kubwa ya kukusanya iko wapi sasa hivi?',
          derivation:
            'GET /v1/receivables — safu 5 za juu open|partially_paid zilizoratibiwa kwa salio (vitu vidogo vya namba)',
          errorTitle: 'Fursa za thamani kubwa hazipatikani',
          sourceEmptyTitle: 'Hakuna madeni kwenye uanzishaji huu bado',
          sourceEmptyDescription:
            'Kisomeleaji cha GET /v1/receivables kilirudisha ukurasa wa kwanza mtupu. Safu huingia kupitia mtiririko wa bili.',
          subsetEmptyTitle: 'Hakuna mabaki ya kufuatilia',
          subsetEmptyDescription: 'Hakuna deni lililoko kwenye hali ya kutolipwa (open / partially_paid).',
          tableLabel: 'Fursa za thamani kubwa',
          overdueBadge: 'imechelewa',
          footerTotal: '{count} za juu kwa salio lisilolipwa — kitabu chote {book}',
          bookCountOnly: 'inasarafu mbalimbali (idadi tu)',
          col: {
            customer: 'Mteja',
            balance: 'Salio',
            aging: 'Umri wa deni',
          },
        },
      },
    },

    collections: {
      statusLabels: {
        open: 'Iliyofunguliwa',
        in_progress: 'Inaendelea',
        resolved: 'Imetatuliwa',
        closed_inactive: 'Imefungwa (haitumiki)',
      },
      actionTypeLabels: {
        call: 'Simu',
        sms: 'SMS',
        whatsapp: 'WhatsApp',
        letter: 'Barua',
        fieldVisit: 'Ziara ya eneo',
        escalation: 'Kupanda kwa ngazi',
      },

      workspace: {
        title: 'Sehemu ya kazi ya makusanyi',
        subtitle: 'Kesa, mfumo wao wa hali, na ngazi za hatua za mkusanyaji.',
      },

      list: {
        title: 'Kesa',
        description:
          'GET /v1/collections/cases — kisomeleaji cha kesa cha shirika, chenye kurasa-za-kishale. Safu ni kumbukumbu zilizofungwa: kazi hufanyika kwenye maelezo ya kesa.',
        sortLabel: 'Panga',
        sortDirectionLabel: 'Mwelekeo wa kupanga',
        refresh: 'Onyesha upya',
        refusedTitle: 'Haikuweza kupakia kesa',
        emptyTitle: 'Hakuna kesa za makusanyi bado',
        emptyDescription:
          'Kisomeleaji cha GET /v1/collections/cases kilirudisha ukurasa wa kwanza mtupu kwa shirika lako.',
        emptyHint: 'Fungua kesa chini ya deni moja au zaidi ili kuanza kufuatilia makusanyi.',
        shownOfTotal: '{shown} kati ya {total} kesa zimeonyeshwa',
        shownCount: '{shown} kesa zimeonyeshwa',
        loadMore: 'Pakia zaidi',
        loading: 'Inapakia…',
        col: {
          case: 'Kesa',
          priority: 'Kipaumbele',
          status: 'Hali',
          derived: 'Iliyotokana',
          actions: 'Hatua',
          opened: 'Iliyofunguliwa',
        },
      },

      open: {
        title: 'Fungua kesa',
        description:
          'POST /v1/collections/cases — kesa MOJA tu isiyo wafa kwa deni (R8); waya hukataa rudufu na 409 CASE_ALREADY_OPEN.',
        toggle: 'Fungua kesa…',
        hide: 'Ficha',
        success: 'Kesa {caseNumber} imefunguliwa.',
        workTheCase: 'Fanyia kazi kesa →',
        refusedTitle: 'Haikuweza kufungua kesa',
        receivablesLegend: 'Madeni ya kufunikwa',
        pickerRefusedTitle: 'Haikuweza kupakia madeni ya kuchagua',
        pickerEmpty: 'Hakuna madeni kwenye uanzishaji huu bado — weka vitambulisho chini, ankara zilipokuwepo.',
        collectorIdLabel: 'Kitambulisho cha mkusanyaji',
        collectorIdPlaceholder: 'UUID ya mkusanyaji aliye assigned',
        priorityLabel: 'Kipaumbele',
        additionalIdsLabel: 'Kitambulisho za ziada za madeni (si lazima)',
        additionalIdsPlaceholder: 'UUID zilizotenganishwa koma au nafasi',
        localErrorNoIds: 'Chagua au weka kitambulisho cha deni angalau moja.',
        localErrorCollector: 'Kitambulisho cha mkusanyaji kinahitajika.',
        submit: 'Fungua kesa',
        submitting: 'Inafungua…',
        reset: 'Anza upya',
      },

      detail: {
        backToCases: '← Rudi kwenye kesa',
        heading: 'Kesa {caseNumber}',
        headingUnnamed: 'Kesa',
        refusedTitle: 'Haikuweza kupakia kesa',
      },

      summary: {
        collectorPrefix: '· mkusanyaji',
        opened: 'Iliyofunguliwa',
        openedBy: 'Iliyofunguliwa na',
        closed: 'Iliyofungwa',
        closedBy: 'Iliyofungwa na',
        coveredReceivables: 'Madeni yaliyofunikwa',
        receivablesRefusedTitle: 'Haikuweza kupakia madeni yaliyofunikwa',
        overdueSuffix: '· imechelewa',
        outstandingTotal: 'Zilizobaki kulipwa: {total}',
        noSingleTotal:
          'Hakuna jumla moja: mabaki yaliyofunikwa hayagawani sarafu moja (au yamezidi jumla salama) — mabaki ya kila deni hapo juu ndiyo ukweli.',
      },

      log: {
        title: 'Kumbukumbu iliyofungwa',
        description: 'Inaongezwa tu, kama waya ilivyoirudisha — hatua, mabadiliko ya hali, mabadiliko ya kipaumbele.',
        sealedNote:
          'Kesa hii ni {status} — kumbukumbu yake imefungwa na waya hukataa kuandika zaidi na 409 CASE_CLOSED.',
        actionsTitle: 'Hatua ({count})',
        actionsEmpty: 'Hakuna hatua zilizorekodiwa bado.',
        awaitingCompletion: 'inasubiri ukamilishaji',
        completedAt: 'imekamilika {at}',
        historyTitle: 'Historia ya mzunguko ({count})',
        historyEmpty: 'Hakuna mabadiliko yaliyorekodiwa bado.',
        historyFromTo: '{from} → {to}',
        historyReason: '— “{reason}”',
        historyMeta: 'saa {at} na {actor}',
        priorityTitle: 'Mabadiliko ya kipaumbele ({count})',
        priorityEmpty: 'Hakuna kupanda kwa ngazi kilichorekodiwa bado.',
        col: {
          type: 'Aina',
          scheduled: 'Iliyopangwa',
          source: 'Chanzo',
          consent: 'Idhini',
          outcome: 'Matokeo',
          state: 'Hali',
        },
      },

      transition: {
        title: 'Mzunguko',
        sealedDescription:
          'Niyo halali tu: open → in_progress, in_progress → resolved | closed_inactive.',
        sealedNote:
          'Kesa hii ni {status} — hali ya mwisho haina niyo, hivyo hakuna cha kubadilisha.',
        description:
          'POST …/transitions — songa kwenye niyo halali. Uamuzi, sababu yake na mtendaji huongezwa kwenye historia ya kesa.',
        success: 'Kesa imesongwa hadi {to}.',
        refusedTitle: 'Haikuweza kusonga kesa',
        moveToLegend: 'Songa hadi',
        reasonLabel: 'Sababu ya mabadiliko (huongezwa kwenye historia ya kesa)',
        reasonPlaceholder: 'Kwa nini kesa inasonga (huandikwa kwenye kumbukumbu ya historia)',
        reasonRequired: 'Sababu inahitajika — mabadiliko huandikwa kwenye historia ya kesa.',
        submit: 'Songa hadi {to}',
        submitting: 'Inasonga…',
      },

      escalation: {
        title: 'Kupanda kwa ngazi',
        sealedDescription:
          'Kupanda tu: low < normal < high < urgent — waya hukataa kuelekeala na kushuka na 400 CASE_ESCALATION_INVALID.',
        sealedNote:
          'Kesa hii iko {priority} — tayari iko juu kabisa ya ngazi, hakuna cha kupanda hadi.',
        description:
          'POST …/escalations — kupanda tu kutoka {from}. Kila kupanda huongezwa kwenye priorityChanges.',
        success: 'Kesa imepandishwa hadi {to}.',
        refusedTitle: 'Haikuweza kupandisha kesa',
        escalateToLegend: 'Pandisha hadi',
        reasonLabel: 'Sababu ya kupanda',
        reasonPlaceholder: 'k.mf. imechelewa siku 60+ na ufikiaji wa eneo hatarini',
        reasonRequired: 'Sababu inahitajika — kupanda huandikwa kwenye kumbukumbu ya kesa.',
        submit: 'Pandisha hadi {to}',
        submitting: 'Inapandisha…',
      },

      record: {
        title: 'Rekodi hatua',
        sealedDescription: 'POST …/actions — ongeza kwenye kumbukumbu ya hatua za kesa.',
        sealedNote:
          'Kesa hii ni {status} — kumbukumbu yake ya hatua imefungwa (waya hukataa kuandika zaidi na 409 CASE_CLOSED).',
        description: 'POST …/actions — ingizo moja kwa kila kutuma/kujaribu, huongezwa kwenye kumbukumbu iliyofungwa.',
        refusedTitle: 'Haikuweza kurekodi hatua',
        typeLabel: 'Aina',
        scheduledLabel: 'Imepangwa (saa za Nairobi)',
        sourceLabel: 'Chanzo',
        consentLabel: 'Kumbukumbu ya idhini ya dunning (K2)',
        consentPlaceholder: 'Kumbukumbu hai ya idhini ya dunning ya kutuma kiotomatiki',
        consentHelp:
          'Dunning ya sms/whatsapp kiotomatiki inahitaji kumbukumbu hai ya idhini — bila hiyo waya hukataa na 403 DUNNING_CONSENT_REQUIRED na hakuna kinachotumwa.',
        outcomeLabel: 'Matokeo (si lazima — huwekwa wakati wa kukamilisha)',
        scheduleRequired: 'Weka tarehe na saa sahihi ya ratiba.',
        consentRequired:
          'Kutuma kiotomatiki nje kunahitaji kumbukumbu ya idhini ya dunning (K2) — hakuna kinachotumwa bila hiyo.',
        success: '{type} imerekodiwa — imepangwa {when}.',
        submit: 'Rekodi hatua',
        submitting: 'Inarekodi…',
      },

      complete: {
        title: 'Kamilisha hatua',
        sealedDescription: 'POST …/actions/:actionId/completions — weka matokeo, mara moja tu.',
        description: 'POST …/actions/:actionId/completions — matokeo huwekwa mara moja tu.',
        emptyNoActions:
          'Hakuna hatua zilizorekodiwa kwenye kesa hii bado — rekodi moja hapo juu, kisha ikamilishe na matokeo yake.',
        emptyAllCompleted: 'Kila hatua iliyorekodiwa imekamilika tayari — hakuna inayosubiri matokeo.',
        success: 'Hatua imekamilika na matokeo “{outcome}”.',
        refusedTitle: 'Haikuweza kukamilisha hatua',
        selectLabel: 'Hatua inayosubiri ukamilishaji',
        optionLabel: '{type} — imepangwa {when}',
        outcomeLabel: 'Matokeo',
        outcomePlaceholder: 'Kilichotokea kweli, k.mf. nilizungumza na msimamizi wa eneo — ameahidi malipo ya sehemu',
        outcomeRequired: 'Matokeo yanahitajika — ukamilishaji huweka kilichotokea kweli.',
        submit: 'Kamilisha hatua',
        submitting: 'Inakamilisha…',
      },
    },

    customers: {
      directory: {
        title: 'Wateja',
        subtitle:
          'Mteja 360. Utambulisho unatokana na vifaa vya kusoma vya madeni na malipo — mkataba wa /v1 haunganishi orodha ya wateja bado.',
        regionLabel: 'Orodha ya wateja',
        cardTitle: 'Orodha',
        derivedCount: '· {count} vilivyotokana',
        refusedTitle: 'Orodha ya wateja haipatikani',
        emptyTitle: 'Hakuna shughuli za wateja bado',
        emptyDescription:
          'Wala kisomeleaji cha madeni wala cha malipo hakikurudisha safu, hivyo hakuna utambulisho wa wateja unaoweza kutokanwa nacho bado.',
        emptyHint: 'Safu huingia kupitia mtiririko wa bili na njia ya ingizo ya Daraja.',
        truncatedNote:
          'Data kubwa: njia ya kusoma iliacha kwenye kikomo cha ukurasa, hivyo orodha hii inashughulikia safu zilizopakiwa tu.',
        footer:
          'utokaji: GET /v1/receivables + GET /v1/payments — customerId tofauti (malipo bila customerId hayawezi kuhusishwa)',
        mixedCurrencyCountOnly: 'sarafu mchanganyiko — idadi tu (R10)',
        rangeCountOnly: 'imezidi upeo sahihi wa namba — idadi tu',
        overdueCount: '{count} zimechelewa',
        viewLink: 'Ona',
        viewLinkSrOnly: 'mteja {id}',
        open360SrOnly: 'Fungua mwonekano wa 360',
        col: {
          customer: 'Mteja',
          outstanding: 'Zilizobaki kulipwa',
          overdue: 'Zilizochelewa',
          receivables: 'Madeni',
          lastActivity: 'Shughuli ya mwisho',
        },
      },

      c360: {
        title: 'Mteja 360',
        subtitle:
          'Madeni, malipo, kesa na mawasiliano yanayohusishwa na mteja huyu — yanavyotoka tu kwenye vifaa vya kusoma vya /v1.',
        allCustomers: 'Wateja wote',
        noActivityTitle: 'Hakuna shughuli za /v1 zinazohusishwa na kitambulisho hiki cha mteja',
        noActivityDescription:
          'Hakuna safu ya deni au malipo inayobeba customerId hii, na kesa zinaweza kuhusishwa tu kupitia madeni. Kitambulisho hiki ni ama kisichojulikana kwenye uanzishaji huu ama hakina shughuli bado.',
        noActivityHint:
          'Mkataba wa /v1 haunganishi orodha ya wateja, hivyo kitambulisho kisichojulikana hakiwezi kutofautishwa na kisichotumika — hakuna kinachotengenezwa kwa njia zote mbili.',
        truncatedNote:
          'Data kubwa: njia ya kusoma iliacha kwenye kikomo cha ukurasa, hivyo mwonekano huu unashughulikia safu zilizopakiwa tu.',
        stats: {
          outstanding: 'zilizobaki kulipwa',
          overdue: 'zilizochelewa',
          confirmed: 'zilizothibitishwa',
          heldOnAccount: 'zilizoshikiliwa kwenye akaunti',
        },
        statFallbacks: {
          noRows: '· hakuna safu bado',
          mixed: '· sarafu mchanganyiko — idadi tu (R10: hakuna jumla za sarafu mbalimbali)',
          range: '· imezidi upeo sahihi wa namba — idadi tu',
        },
        agingTitle: 'Vikapu vya umri wa deni (salio lisilolipwa)',
        agingMixed: 'sarafu mchanganyiko (R10)',
        agingRange: 'imezidi upeo sahihi',
        terminalOne: 'deni {count} zaidi limelipwa, limeandikwa hasara au limefungwa kwa njia nyingine.',
        terminalMany: 'madeni {count} zaidi yamelipwa, yameandikwa hasara au yamefungwa kwa njia nyingine.',
        overdueBadge: 'imechelewa',
        paymentRow: {
          requestedLabel: 'iliyoombwa',
          confirmedLabel: 'iliyothibitishwa',
          unappliedSuffix: '{amount} haijatumika',
          initiatedPrefix: 'ilianzishwa {at}',
          failureCodePrefix: 'msimbo wa kushindikana:',
          reversalReasonPrefix: 'sababu ya kurejeshwa:',
          appliedTo: 'yametumika kwenye deni {id}',
          refunded: 'yamerejeshwa',
        },
        promises: {
          title: 'Ahadi',
          empty: 'Hakuna kesa zenye ahadi hai.',
          missed: 'imepita',
          dueNow: 'muda umefika',
          scheduled: 'imepangwa',
          noPendingFollowUp: 'hakuna ufuatilio unaosubiri',
          nextFollowUp: 'ufuatilio ujao {at}',
        },
        openCaseCountSuffix: 'zilizo wazi ({total} jumla ikijumuisha zilizotatuliwa/zilizofungwa)',
        commsRow: {
          pending: 'inasubiri',
          completed: 'imekamilika',
          scheduledAt: 'imepangwa {at}',
          completedAt: 'imekamilika {at}',
          consentRefPrefix: 'kumbukumbu ya idhini:',
        },
        receivables: {
          cardTitle: 'Madeni & umri wa deni',
          question: 'Mteja huyu anadaiwa nini, na umri wa deni ni kina gani?',
          derivation:
            'GET /v1/receivables — kichujio cha customerId; umri wa deni juu ya safu open|partially_paid (pesa zilizolipwa haziumriwi)',
          errorTitle: 'Madeni hayapatikani',
          emptyDeploymentTitle: 'Hakuna madeni kwenye uanzishaji huu bado',
          emptyDeploymentDescription:
            'Kisomeleaji cha GET /v1/receivables kilirudisha ukurasa wa kwanza mtupu. Safu huingia kupitia mtiririko wa bili.',
          emptyCustomerTitle: 'Hakuna deni lenye kitambulisho hiki cha mteja',
          emptyCustomerDescription:
            'Kisomeleaji cha madeni kina safu, lakini hakuna kurasa iliyopakiwa inayohusisha customerId hii.',
          col: {
            invoice: 'Ankara',
            state: 'Hali',
            balance: 'Salio',
            due: 'Muda wa kulipa',
            aging: 'Umri wa deni',
          },
        },
        payments: {
          cardTitle: 'Historia ya malipo & matumizi',
          question: 'Fedha gani zilihamishwa, na zilitumika wapi?',
          derivation:
            'GET /v1/payments — kichujio cha customerId; matumizi yametenganishwa kutoka safu za allocations[]',
          errorTitle: 'Historia ya malipo haipatikani',
          emptyDeploymentTitle: 'Hakuna malipo kwenye uanzishaji huu bado',
          emptyDeploymentDescription:
            'Kisomeleaji cha GET /v1/payments kilirudisha ukurasa wa kwanza mtupu. Pesa huingia kupitia njia ya ingizo ya Daraja.',
          emptyCustomerTitle: 'Hakuna malipo yenye kitambulisho hiki cha mteja',
          emptyCustomerDescription:
            'Kisomeleaji cha malipo kina safu, lakini hakuna kurasa iliyopakiwa inayohusisha customerId hii (malipo bila customerId hayawezi kuhusishwa).',
        },
        cases: {
          cardTitle: 'Kesa za makusanyi & ahadi',
          question: 'Je mteja huyu yuko kwenye makusanyi hai, na ameahidi nini?',
          derivation:
            'GET /v1/collections/cases — zinahusishwa kupitia receivableIds; ahadi kutoka overlay ya derivedStatus + hatua ya kwanza isiyokamilika',
          errorTitle: 'Kesa za makusanyi hazipatikani',
          attributionErrorTitle: 'Uhusishaji wa kesa haupatikani',
          emptyDeploymentTitle: 'Hakuna kesa za makusanyi bado',
          emptyDeploymentDescription:
            'GET /v1/collections/cases ilirudisha ukurasa wa kwanza mtupu — fungua kesa ili kuanza kufuatilia.',
          emptyCustomerTitle: 'Hakuna kesa inayogusa madeni ya mteja huyu',
          emptyCustomerDescription:
            'Kesa zinahusisha wateja tu kupitia receivableIds; hakuna kesa iliyopakiwa inayofunika madeni ya mteja huyu.',
          col: {
            case: 'Kesa',
            priority: 'Kipaumbele',
            status: 'Hali',
            actions: 'Hatua',
            opened: 'Iliyofunguliwa',
          },
        },
        comms: {
          cardTitle: 'Ratiba ya mawasiliano',
          question: 'Nini kimesemwa, kutumwa na kupangwa na mteja huyu?',
          derivation:
            'hatua za kesa za kesa zilizohusishwa — GET /v1/collections/cases (actions[]; hakuna mwisho maalum wa mawasiliano unaounganishwa)',
          errorTitle: 'Ratiba ya mawasiliano haipatikani',
          attributionErrorTitle: 'Uhusishaji wa mawasiliano haupatikani',
          emptyDeploymentTitle: 'Hakuna kesa za makusanyi bado',
          emptyDeploymentDescription:
            'Kumbukumbu ya mawasiliano inatokana na hatua za kesa, na kisomeleaji cha kesa ni tupu.',
          emptyCustomerTitle: 'Hakuna hatua za kesa kwa mteja huyu bado',
          emptyCustomerDescription:
            'Kesa za mteja huyu hazina hatua zilizorekodiwa (simu, jumbe, barua, ziara, kupanda kwa ngazi) bado.',
        },
      },
    },

    reconciliation: {
      title: 'Ulinganishi',
      bodyPrefix:
        "Ulinganishi (Matched / Suggested / Unmatched / Duplicates / Amount mismatch) unahitaji kisomeleaji cha injini ya ulinganishi kwenye /v1. Uwezo wa mkataba uliounganishwa leo ni",
      /** Majina ya uwezo wa waya hubaki yenyewe — yanaita mkataba. */
      capabilities: 'auth, collections, payments, receivables',
      bodySuffix: '.',
      emptyTitle: 'Hakuna uso wa ulinganishi uliounganishwa kwenye /v1 bado',
      emptyDescription:
        'api/openapi/fuatilia.v1.yaml inaonyesha operesheni 22 juu ya health, auth admin, receivables, payments na collections cases — hakuna yao ni ulinganishi.',
      emptyHint: 'Fuatilia hatua inayofuata ya njia ya malipo itakayounganisha kisomeleaji cha ulinganishi.',
    },

    settings: {
      title: 'Mipangilio',
      bodyPrefix:
        'Mkataba wa /v1 unaunganisha mabadiliko ya auth-admin (unda mtumiaji, toa/ondoa wadhifa, toa/ondoa ufunguo wa API, ondoa kipindi) nyuma ya',
      /** Wigo wa ruhusa hubaki wenyewe — unaita mkataba. */
      scope: 'admin:manage-users',
      bodySuffix: ', lakini hakuna operesheni za orodha/kusoma za kutengeneza majedwali ya usimamizi.',
      emptyTitle: 'Usimamizi wa mipangilio utakuja na vifaa vya kusoma vya auth-admin',
      emptyDescription:
        'Hadi /v1 itakapoonyesha operesheni za kusoma users/grants/keys, usimamizi unafanyika kupitia API moja kwa moja; koni haioneshi data mbadala.',
      emptyHint:
        'Njia ya hatua itaongeza react-hook-form + mabadiliko yaliyodhibitiwa na sera kwenye ukurasa huu.',
    },
  },

  // =========================================================================
  // (auth) — uso wa vitambulisho (issue #180).
  // =========================================================================
  auth: {
    meta: {
      /** Kichwa cha tab ya kivinjari kwa kundi la njia la auth. */
      title: 'Fuatilia — Ingia',
      description: 'Kuingia kwa mkusanyaji kwenye koni ya makusanyi ya Fuatilia.',
    },

    signIn: {
      title: 'Ingia kwenye Fuatilia',
      intro:
        'Koni ya makusanyi ya timu yako. Weka kitambulisho cha kipindi ambacho msimamizi wako wa Fuatilia alitoa ili kuanza.',
      credentialLabel: 'Kitambulisho cha kipindi',
      credentialHelp:
        'Kitambulisho kinathibitishwa dhidi ya API hai mara moja, kisha kinashikiliwa kwenye cookie ya HTTP-only, SameSite=Strict na kupelekwa kwa API upande wa seva. Hakiwekwi kwenye URL, hakihifadhiwi kwenye kivinjari chako, na hakisomeki na maandishi ya programu kwenye ukurasa huu.',
      emptyCredentialError: 'Weka kitambulisho cha kipindi ambacho msimamizi wako alitoa.',
      submit: 'Fungua koni',
      submitting: 'Inathibitisha…',
      refusedTitle: 'Kitambulisho hiki cha kipindi hakikubaliwa',
      refusedDescription:
        'Angalia kitambulisho kisha ujaribu tena, au muombe msimamizi wako wa Fuatilia kipindi kipya.',
      unreachableTitle: 'API haikufikiwa',
      unreachableBody:
        'Kitambulisho hakikuweza kuthibitishwa, hivyo hakuna kilichofunguliwa. Jaribu tena baada ya kidogo — hakuna ufikiaji unaotolewa kwa kitambulisho isiyothibitika.',
      seamNoteTitle: 'Jinsi kuingia kunavyofanya kazi leo:',
      seamNoteBody:
        'mkataba wa /v1 uliounganishwa hutoa vipindi kupitia njia ya auth admin, si kupitia fomu ya jina la mtumiaji/nenosiri — hivyo skrini hii inakubali kitambulisho cha kipindi chenyewe na kuuthibitisha dhidi ya operesheni iliyolindwa hai kabla koni haijafunguka. Hakuna kilichosimuliwa hapa.',
    },

    signOut: {
      title: 'Toka kwenye Fuatilia',
      done: 'Umetoka. Cookie ya kipindi imefutwa kwenye kivinjari hiki.',
      signInAgain: 'Ingia tena',
      failed: 'Ombi la kutoka halikukamilika. Cookie ya kipindi inaweza kuwapo bado — jaribu tena.',
      help: 'Kutoka kunamaliza muda wa cookie ya kipindi ya HTTP-only kwenye kivinjari hiki. Kitambulisho chenyewe hakisomeki na ukurasa huu kamwe.',
      submit: 'Toka',
      submitting: 'Inatoka…',
    },
  },
} satisfies Dictionary;
