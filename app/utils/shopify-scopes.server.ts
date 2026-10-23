/**
 * The Admin SDK's scopes.query() reads the current grant from Shopify. It is
 * authoritative for authorization decisions; Session.scope is only persisted
 * OAuth metadata and can be stale after a merchant updates app permissions.
 */
export type ShopifyScopesApi = {
  query: () => Promise<unknown>;
};

export async function queryGrantedScopes(scopesApi: ShopifyScopesApi): Promise<string[]> {
  const details = await scopesApi.query();
  if (
    typeof details !== "object" ||
    details === null ||
    !("granted" in details) ||
    !Array.isArray(details.granted) ||
    !details.granted.every(
      (scope) => typeof scope === "string" && scope.length > 0 && scope.trim() === scope,
    )
  ) {
    throw new Error("Shopify returned malformed scope grant data.");
  }

  return [...new Set(details.granted)];
}

export function missingScopesForGrant(
  granted: readonly string[],
  required: readonly string[],
): string[] {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
}
