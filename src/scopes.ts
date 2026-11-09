// The scopes as openccu-lite reads them (occulited's docs/system-api.md, the scopes table): a write
// includes its read, each rpc tier the ones before it, and Full access (`*`) everything. The system
// lists only the highest scope a token holds - a token paired for devices at operate reads
// ["meta:read", "rpc:operate"], no rpc:read beside it - so a scope is never looked up literally.

/** What a scope brings along, as on the system: a write its read, a tier the ones before it. */
export const SCOPE_INCLUDES: Readonly<Record<string, readonly string[]>> = {
    'meta:write': ['meta:read'],
    'system:write': ['system:read', 'led'],
    'addons:write': ['system:read'],
    'auth:admin': ['self'],
    power: ['power:halt'],
    'rpc:operate': ['rpc:read'],
    'rpc:configure': ['rpc:operate', 'rpc:read'],
    'rpc:admin': ['rpc:configure', 'rpc:operate', 'rpc:read'],
};

const coveredBy = (have: string, want: string): boolean => have === want || have === '*' || (SCOPE_INCLUDES[have]?.includes(want) ?? false);

/** Whether a credential holding `scopes` may do what needs `want`: the scope itself, Full access, or a
 *  scope that includes it (`rpc:admin` covers `rpc:read`, `meta:write` covers `meta:read`). */
export function covers(scopes: readonly string[], want: string): boolean {
    return scopes.some((have) => coveredBy(have, want));
}

/** The list as the system shows it: Full access alone when it is in, else sorted, without repetitions
 *  and without the scopes another entry already covers (`self` never). */
export function normalizeScopes(scopes: readonly string[]): string[] {
    if (scopes.includes('*')) return ['*'];
    const out = new Set<string>();
    for (const a of scopes) if (a !== 'self' && !scopes.some((b) => b !== a && coveredBy(b, a))) out.add(a);
    return [...out].sort();
}
