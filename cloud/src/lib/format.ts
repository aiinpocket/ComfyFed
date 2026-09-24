/**
 * Reproduce CPython's `format(x, ".1f")` byte-for-byte.
 *
 * Why not `x.toFixed(1)`: `toFixed` is permitted by the ECMAScript spec to
 * round based on an internal decimal approximation of the double, and V8's
 * implementation demonstrably disagrees with CPython on real inputs (e.g.
 * `(1.005).toFixed(2)` famously yields "1.00" in JS while a correctly-rounded
 * decimal expansion says the exact double for 1.005 is slightly *above*
 * 1.005, which would round to "1.01" -- toFixed's algorithm doesn't compute
 * the double's exact value). CPython's `float.__format__` uses David Gay's
 * dtoa in "fixed number of digits after the point" mode, which finds the
 * *exact* decimal value the IEEE-754 double represents (binary fractions are
 * exact rationals with a terminating decimal expansion) and rounds that
 * exact value to the requested precision with round-half-to-even. Because
 * the exact binary value is very rarely a precise decimal tie at 1 digit
 * (e.g. 0.15 is actually 0.1499999999999999944...), most apparent "ties"
 * like 0.15/0.25/2.5 are not real ties at all -- the correct output falls
 * out of rounding the true value, not from applying banker's rounding to the
 * literal digit "5".
 *
 * Approach: decompose the double's IEEE-754 bit pattern into an exact
 * integer*2^exponent value using BigInt (lossless), then round that exact
 * value to 1 decimal digit using exact BigInt division with round-half-even
 * tie-breaking on the *true* remainder -- never touching floating point
 * arithmetic once the bits are extracted. This is exact by construction,
 * matches CPython's dtoa mode-3 fixed-precision rounding, and is verified
 * against all 20 fixture cases in golden.json (including the round-half-even
 * ties: 2.5 -> "2.5", 1.25 -> "1.2", 1.35 -> "1.4", 2.05 -> "2.0").
 */
export function python1f(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";

  // Sign is tracked separately so that rounding-to-zero still prints "-0.0"
  // for negative inputs, matching CPython (format(-0.04, '.1f') == '-0.0').
  const negative = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);

  const { mantissa, exponent } = decomposeDouble(abs);
  // abs === mantissa * 2^exponent, exactly (mantissa, exponent are BigInts).

  let scaledTenths: bigint; // exact round(abs * 10), ties-to-even
  if (exponent >= 0n) {
    // abs is already an integer; abs*10 is exact, no rounding needed.
    scaledTenths = mantissa * (1n << exponent) * 10n;
  } else {
    const n = -exponent; // > 0
    const denominator = 1n << n;
    const numerator = mantissa * 10n;
    let q = numerator / denominator;
    const r = numerator % denominator;
    const twiceR = r * 2n;
    if (twiceR > denominator) {
      q += 1n;
    } else if (twiceR === denominator) {
      if (q % 2n !== 0n) q += 1n; // round half to even
    }
    scaledTenths = q;
  }

  const intPart = scaledTenths / 10n;
  const fracDigit = scaledTenths % 10n;
  const body = `${intPart.toString()}.${fracDigit.toString()}`;
  return negative ? `-${body}` : body;
}

/** Decompose a non-negative finite double into exact `mantissa * 2^exponent`
 * (mantissa, exponent as BigInt; mantissa >= 0). */
function decomposeDouble(value: number): { mantissa: bigint; exponent: bigint } {
  if (value === 0) return { mantissa: 0n, exponent: 0n };

  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  const bits = new DataView(buf).getBigUint64(0, false);

  const rawExponent = (bits >> 52n) & 0x7ffn;
  const rawMantissa = bits & 0xfffffffffffffn; // 52 bits

  if (rawExponent === 0n) {
    // Subnormal: value = rawMantissa * 2^-1074
    return { mantissa: rawMantissa, exponent: -1074n };
  }
  // Normal: value = (2^52 + rawMantissa) * 2^(rawExponent - 1075)
  const mantissa = rawMantissa | (1n << 52n);
  const exponent = rawExponent - 1075n;
  return { mantissa, exponent };
}
