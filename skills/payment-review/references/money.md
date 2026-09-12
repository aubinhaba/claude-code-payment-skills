# Money — the invariants a review should assert

Money bugs are not caught by types unless you give them types. Most of the defects
below compile, pass review at a glance, and are found by an accountant.

## Representation

**Never `float` or `double`.** `0.1 + 0.2 != 0.3` is not a curiosity, it is a
reconciliation break. Two acceptable representations:

- `BigDecimal` with an explicit scale, or
- integer **minor units** (`long cents`), which is what most PSP APIs speak.

Minor units are not universally two decimals. JPY and KRW have zero, TND and BHD have
three. Any code that hardcodes `amount * 100` is wrong for a currency you will onboard
eventually. Derive the exponent from the currency (`java.util.Currency#getDefaultFractionDigits`,
or the PSP's own table when it differs).

**Amount and currency are one value.** A method that takes `(long amount, String currency)`
lets a caller pass them in the wrong order, or forget the currency in one branch. A
`Money` record makes the mistake unrepresentable:

```java
public record Money(long minorUnits, Currency currency) {
    public Money {
        Objects.requireNonNull(currency);
    }

    public static Money ofMinor(long minorUnits, Currency currency) {
        return new Money(minorUnits, currency);
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.addExact(minorUnits, other.minorUnits), currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.subtractExact(minorUnits, other.minorUnits), currency);
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            throw new CurrencyMismatchException(currency, other.currency);
        }
    }
}
```

`Math.addExact` rather than `+`: an overflow on a money total should fail loudly, not
wrap around. Neither event should ever happen, which is exactly why the one that does
must not be silent.

## Comparison

`BigDecimal.equals` compares scale as well as value: `new BigDecimal("10.0")` is not
equal to `new BigDecimal("10.00")`. Use `compareTo(...) == 0`. This shows up in refund
"is this the full amount?" checks, where one side comes from the database (scale 2) and
the other from a PSP response (scale 1), and the full refund is recorded as partial.

If the codebase uses `BigDecimal` in entities, check `equals`/`hashCode` on any value
object wrapping it, and any use of a `Set<Money>` or a map keyed by amount.

## Rounding

Every division needs a stated `RoundingMode`. `BigDecimal.divide(BigDecimal)` without
one throws `ArithmeticException` on a non-terminating result — which is the safe
failure — but the fix must be a decision, not the first mode someone typed.

Where rounding decisions accumulate:

- **Instalments.** 100.00 in 3 payments is 33.33 + 33.33 + 33.34, not 33.33 × 3. The
  residual must be allocated deterministically (usually to the first or the last
  instalment) and the rule stated in the code, because the customer will add them up.
- **Split payments / marketplace fees.** Platform fee, PSP fee and merchant net must sum
  exactly to the charged amount. The residual goes somewhere by rule; if no rule exists,
  the reconciliation report grows a one-cent daily drift.
- **Tax.** Rounding per line or on the total gives different results, and the
  jurisdiction decides which is correct.
- **Currency conversion.** The rate, its source and its timestamp belong in the stored
  record. A converted amount without the rate that produced it cannot be explained to a
  merchant six months later.

Assert the invariant in a test rather than trusting the arithmetic:

```java
@Test
void instalments_sum_exactly_to_the_total() {
    Money total = Money.ofMinor(10_000, EUR);      // 100.00
    List<Money> parts = Instalments.split(total, 3);
    assertThat(parts).hasSize(3);
    assertThat(sum(parts)).isEqualTo(total);        // the only assertion that matters
}
```

Then run it as a property over many totals and counts. Instalment splitting is the
canonical place where a property-based test pays for itself in one afternoon.

## Sign and direction

Refunds as negative amounts, or as positive amounts on a different record type, are both
defensible. Mixing the two conventions in one codebase is not. Check which convention
the diff follows and whether any aggregation sums across both.

A ledger with a sign convention needs the invariant written down: for a given payment,
`sum(credits) - sum(debits)` equals the balance, and the balance is never negative unless
the domain allows it.

## The invariants worth enforcing structurally

These belong in the database, not only in the service, because the service will one day
run in two pods at once:

| Invariant | Enforcement |
| :--- | :--- |
| Captured ≤ authorized, or ≤ the over-capture ceiling the card network grants the merchant category | Check constraint on the payment row, or a guarded UPDATE — with the ceiling held as data, not as a literal |
| Σ refunds ≤ captured | Constraint on a derived total, or `SELECT ... FOR UPDATE` on the payment before insert |
| One refund per idempotency key | Unique index on `(merchant_id, idempotency_key)` |
| Terminal state never leaves | `UPDATE ... WHERE status = 'PENDING'` and assert one row affected |
| Amount is non-negative | `CHECK (amount_minor >= 0)` |
| Currency is a known code | Foreign key to a currency table, or a check constraint |

A read-then-write check in application code is not an enforcement. It is a race with a
comfortable success rate.

## Review checklist

- [ ] No `float`/`double` anywhere in the money path, including DTOs and JSON contracts
- [ ] Amount never travels without its currency
- [ ] Minor-unit exponent derived from the currency, not hardcoded
- [ ] `compareTo` rather than `equals` for `BigDecimal`
- [ ] Every division has an explicit `RoundingMode` and a residual rule
- [ ] Split/instalment amounts sum exactly to the total, proven by a test
- [ ] Refund ≤ capture ≤ authorization (or its over-capture ceiling), enforced in the database
- [ ] Conversion rate and timestamp persisted with any converted amount
- [ ] Overflow fails loudly (`Math.addExact`) rather than wrapping
- [ ] Amounts at capture/refund come from the stored record, never from the client
