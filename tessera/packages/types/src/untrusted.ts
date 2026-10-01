// TM-1 — the trust boundary, expressed as a nominal type. The compiler holds
// the operations that would hand a consumer the payload itself; lint and the
// pins in test/untrusted.test.js hold the rest. Both lists are below, because
// which half holds a given operation decides where a new guard has to go.
//
// DESIGN §9.1 classifies every script body read off an instance as UNTRUSTED
// INPUT: business rules, Script Includes and client scripts are authored by
// anyone holding write access on `source`, and their comments and string
// literals are attacker-controllable. §9.2 walks the chain that follows if such
// a string reaches a generation prompt unmarked — the model reads an embedded
// imperative as an instruction, emits a "Run Server Side Script" ATF step
// carrying the hostile body, and the runner executes it with real privileges.
// DEV-4's rollback envelope does not save you: DR-5 lists tables (Email, ECC
// Queue, History) that are never rolled back, so an injected step signals or
// exfiltrates before the transaction unwinds.
//
// A convention cannot survive that. "Remember not to interpolate script bodies"
// holds until the first refactor that inlines a variable. So the brand is
// nominal and OPAQUE: an `Untrusted<string>` is not a `string`, is not
// assignable to one, and cannot be passed to a function expecting text. Those
// two the COMPILER refuses, and they are the ones that would hand a consumer
// the payload itself.
//
// Know which operations it does NOT refuse, because that decides where the
// rest of the guard has to live:
//   - Template interpolation, `+` concatenation and `String()` all typecheck.
//     What stops them is the type-checked ESLint set
//     (restrict-template-expressions, restrict-plus-operands,
//     no-base-to-string), whose glob is `packages/*/src/**/*.ts` — a test, a
//     script, or any file outside that glob has no such guard. Their runtime
//     result is "[object Object]": noisy, and not a leak.
//   - `JSON.stringify` is stopped by nothing, and it is the one that leaks:
//     it walks the runtime box and emits {"value":"<the hostile body>"} in
//     the clear. No type can forbid it — `stringify` accepts `unknown`. Read
//     serialising a structure that still holds branded values as an unwrap
//     nobody wrote down.
// Both of those behaviours are pinned in test/untrusted.test.js, so a change
// to either shows up as a deliberate edit rather than a silent drift.
//
// PROVENANCE (delegated decision 2026-09-23, TODO "TM-1's runtime guarantee
// has two holes"): the door no longer accepts anything SHAPED like a box. It
// accepts only a box `untrusted()` itself minted, recorded in the
// module-private `minted` WeakSet below. A hand-rolled `{ value }`, a JSON
// round trip, a spread (`{ ...box }`) or a `structuredClone` of a real box
// is a new object nobody minted, and the door refuses it. The consequence is
// deliberate: a branded value cannot cross a process, queue, cache or HTTP
// hop and still open the door — whatever reads it on the far side has to
// brand it again with `untrusted()`, at that ingestion boundary, which is
// exactly where DESIGN §9.1 wants the brand applied.
//
// WRITTEN CONCESSION — the JSON.stringify leak stays open. The marker proves
// provenance; it does nothing about what a serialiser can READ, and the box
// still carries its payload as an ordinary enumerable `value`. Hiding the
// payload (a non-enumerable field, or a WeakMap keyed by the box) would make
// `JSON.stringify` emit `{}` instead — trading a visible leak for silent
// data loss in every structure somebody serialises for a legitimate reason
// (an evidence dump, a fixture), with no error to say what vanished. A
// throwing `toJSON` was rejected earlier for the same blast radius. So TM-1
// makes no runtime claim about serialisation: serialising a structure that
// holds branded values is an unwrap nobody wrote down, and review is the
// only guard. Pinned positively in test/untrusted.test.js.
//
// There is exactly one door out — `unwrapUntrusted`, which demands you name
// the boundary you are crossing, and which is therefore greppable. Every
// unwrap in this workspace is meant to be readable as a sentence explaining
// why *that* use of a hostile string is safe. `mapUntrusted` goes through
// that same door with a boundary fixed at its definition; its comment says
// what that does and does not buy.
//
// Phase 3 (the ImpactAnalyzer) is the first stage that reads such text, which
// is why the brand lands here now and not in Phase 2 — the resolvers read
// identity only, and a wrapper with nothing dangerous inside it would have
// looked satisfied while proving nothing.

declare const untrustedBrand: unique symbol;

/**
 * A value that came off an instance record and has not been cleared by
 * anything. Deliberately opaque: `Untrusted<string>` has no string methods and
 * is not assignable to `string`, so there is no accidental path from an
 * artifact body into a prompt, a query or a rendered report.
 *
 * The type-level brand is a phantom; at runtime the value is carried in a
 * one-field box whose provenance is recorded in the module-private `minted`
 * WeakSet, which is what the door checks.
 */
export interface Untrusted<T> {
  readonly [untrustedBrand]: T;
}

/** The runtime shape. Never exported: reaching `.value` must go through the door. */
interface UntrustedBox<T> {
  readonly value: T;
}

/**
 * Every box `untrusted()` has minted, and nothing else. Module-private and
 * weakly held: membership is the provenance proof the door checks, it cannot
 * be forged from outside this module, and it does not keep a box alive. It
 * relies on there being ONE instance of this module per process — true for
 * the workspace, where every package resolves `@tessera/types` to the same
 * realpath; a second copy of the package would mint boxes the first refuses.
 */
const minted = new WeakSet<object>();

/**
 * Brand a value at the ingestion boundary. Call this the moment a field leaves
 * the HTTP response and before anything else touches it — a body that travels
 * even one function unbranded is a body somebody can use.
 */
export function untrusted<T>(value: T): Untrusted<T> {
  const box: UntrustedBox<T> = { value };
  minted.add(box);
  return box as unknown as Untrusted<T>;
}

/**
 * The one door out, and it is deliberately awkward.
 *
 * `boundary` is not decoration and it is not logged: it exists so that every
 * unwrap in the codebase carries, at the call site, the argument for why
 * handing this particular hostile string to this particular consumer is safe.
 * A reviewer greps for `unwrapUntrusted` and reads the boundaries; a call whose
 * boundary string cannot be written honestly is a call that should not exist.
 *
 * @throws TypeError if `boundary` is blank, or if `value` is not a box that
 * `untrusted()` minted in this process. That second test is a PROVENANCE
 * check (the `minted` WeakSet): a bare string, number, null, array or
 * function cast past the compiler is refused, and so is a hand-rolled
 * `{ value: ... }`, a JSON round trip, a spread or a structuredClone of a
 * real box. (Pinned by this package's own tests and by @tessera/generate's
 * gate test.) What it cannot see is a payload read OUT of a real box without
 * the door — `JSON.stringify` — see the written concession in the header.
 */
export function unwrapUntrusted<T>(value: Untrusted<T>, boundary: string): T {
  if (boundary.trim() === "") {
    throw new TypeError(
      "unwrapUntrusted requires a boundary: name what this value is about to cross (TM-1)",
    );
  }
  if (!isUntrusted(value)) {
    throw new TypeError(
      "unwrapUntrusted received a value that was never branded by untrusted() (TM-1)",
    );
  }
  return (value as unknown as UntrustedBox<T>).value;
}

/**
 * Re-brand the result of a transform, so a caller that only needs to normalise
 * or truncate does not have to write an unwrap of its own. The result is still
 * branded — nothing in here launders anything.
 *
 * Read the exposure honestly, because the header above says there is exactly
 * one door: `fn` receives the payload IN THE CLEAR, and the boundary sentence
 * handed to the door is the fixed literal below, so a `mapUntrusted` call
 * states no argument of its own for why its `fn` is safe. An `fn` that logs,
 * interpolates or stores the raw value leaks exactly as `unwrapUntrusted`
 * would. What routing through the one door buys here is that the door stays
 * greppable and the RESULT is re-branded — not that the payload goes unseen.
 */
export function mapUntrusted<T, U>(
  value: Untrusted<T>,
  fn: (raw: T) => U,
): Untrusted<U> {
  return untrusted(fn(unwrapUntrusted(value, "mapUntrusted — stays branded")));
}

/**
 * True exactly for a box `untrusted()` minted in this process — the same
 * provenance check the door makes, so "could this be unwrapped?" and "was
 * this branded?" are now the same question. A hand-rolled `{ value: ... }` or
 * a JSON round trip of a real box answers false. A type guard is NOT provided
 * on purpose: `isUntrusted(x)` narrowing an arbitrary `unknown` to
 * `Untrusted<string>` would be a second door, and the whole point is that there
 * is one.
 */
export function isUntrusted(value: unknown): boolean {
  return typeof value === "object" && value !== null && minted.has(value);
}
