/**
 * Jurisdiction restriction policy — block payments based on the agent's
 * billing country, the recipient's country (when known), or both.
 *
 * @license Apache-2.0
 */

import type { Policy, PolicyDecision, PolicyEvaluationContext } from "../policy.js";

export interface JurisdictionRestrictionOptions {
  /** ISO 3166-1 alpha-2 country codes blocked (e.g., ["IR", "KP", "RU"]). */
  readonly blockedCountries: ReadonlyArray<string>;
  /**
   * Function to read the recipient's country from a request. Returns
   * undefined if unknown. Free-form: implement against your KYC store.
   */
  readonly recipientCountry?: (ctx: PolicyEvaluationContext) => string | undefined;
  /** Where to read the initiator's country. Default `session.metadata.country`. */
  readonly initiatorCountry?: (ctx: PolicyEvaluationContext) => string | undefined;
  /** What to do when neither side has a country: allow or deny. Default deny. */
  readonly onUnknown?: "allow" | "deny";
}

/**
 * Returns a Policy that denies if either side's country is in the blocked
 * list. Comparison is case-insensitive.
 */
export function jurisdictionRestriction(
  opts: JurisdictionRestrictionOptions
): Policy {
  const blocked = new Set(opts.blockedCountries.map((c) => c.toUpperCase()));
  const initFn = opts.initiatorCountry ?? defaultInitiator;
  const recFn = opts.recipientCountry ?? (() => undefined);
  const onUnknown: "allow" | "deny" = opts.onUnknown ?? "deny";
  const name = `jurisdictionRestriction(${[...blocked].join(",")})`;

  return (ctx: PolicyEvaluationContext): PolicyDecision => {
    const init = initFn(ctx)?.toUpperCase();
    const rec = recFn(ctx)?.toUpperCase();

    if (init === undefined && rec === undefined) {
      return onUnknown === "deny"
        ? {
            allowed: false,
            policyName: name,
            reason: "country_unknown",
            severity: "warn",
          }
        : { allowed: true, policyName: name };
    }
    if (init && blocked.has(init)) {
      return {
        allowed: false,
        policyName: name,
        reason: `initiator_country_blocked: ${init}`,
        severity: "critical",
      };
    }
    if (rec && blocked.has(rec)) {
      return {
        allowed: false,
        policyName: name,
        reason: `recipient_country_blocked: ${rec}`,
        severity: "critical",
      };
    }
    return { allowed: true, policyName: name };
  };
}

function defaultInitiator(ctx: PolicyEvaluationContext): string | undefined {
  const m = ctx.session.metadata;
  if (m && typeof m["country"] === "string") return m["country"];
  return undefined;
}
