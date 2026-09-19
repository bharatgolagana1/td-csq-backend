# CSQ

Cargo Service Quality: the independent performance standard for air cargo terminals.

A terminal is assessed three ways inside a timed cycle. It assesses itself, a
locked sample of its own freight forwarders and customs brokers assess it, and an
independent auditor assesses it. Scores roll up to a published rating.

## Layout

```
packages/contracts   zod schemas, inferred types, the error-code union, ScoreEnvelope.
                     The single wire truth, consumed unchanged by the frontend.
packages/core        pure and IO-free: the scoring pipeline, sampling rules and
                     cycle predicates. No database, no clock, no network.
apps/api             Express API: the kernel (config, auth, tenancy, route policy)
                     plus feature modules. See apps/api/README.md
apps/worker          task runner, outbox drainer, provisioning, scoring (next)
```

`packages/core` is deliberately free of IO so the two places a bug is fatal, the
scoring engine and the sampling gate, can be tested exhaustively without a
database in the loop.

## Working on it

```sh
pnpm install
pnpm -r build        # contracts must build before core; project references handle it
pnpm -r test
```

## Decisions worth knowing before you read the code

**The scale is five points plus NA.** The ACFI paper forms print a 1-10 column;
CSQ renders that same question text on the five-point scale. There is no
ten-point path anywhere.

**NA is not a sixth score.** It leaves the calculation and its weight is
redistributed across the questions that were answered, so a terminal is never
penalised for a parameter that does not apply to it. `scoreCoverageBp` on every
envelope reports how much of the instrument actually got answered.

**One answer carries two directional ratings.** Export and import for
international terminals, inbound and outbound for domestic. The question text is
stored once. Two near-identical questions would break cross-form analytics and
let the wording drift between columns.

**Self-assessment never reaches the published score.** It is recorded and
reported back, because the gap between it and the customer score is the most
useful number the system produces, but it cannot flatter the rating.

**A score is never a bare number.** Everything travels in `ScoreEnvelope` with
its coverage, response count, suppression reason and the weighting profile that
produced it, so any published figure is reproducible and a thin one is visibly
thin.

**Question codes are ordinal-free.** `ACFI.INFRA.TC_BC_GENERATION`, never
`ACFI.1.7`. The international form numbers trade facilitation as section 5 and
the domestic form numbers it 4; printed numbering is a display property.

**Cross-tenant reads return 404, not 403.** A 403 would turn every list endpoint
into an enumeration oracle for competitor identifiers.

The prototype that preceded this is preserved on `archive/prototype-2024`. It is
not a reference: it verified no token signatures, protected no routes, and derived
its ratings from how many checkboxes were ticked rather than the assessor's choice.
