// One error class for everything the client reports: the API's own codes (unauthenticated,
// forbidden, too-many-streams, unknown-interface, down, unsupported, the metadata codes) and the
// client's (unreachable, timeout, certificate, rpc-fault, protocol).

export interface CertificateInfo {
    subject?: string;
    issuer?: string;
    fingerprint256?: string;
    validFrom?: string;
    validTo?: string;
}

export class OccuLiteError extends Error {
    readonly code: string;
    readonly status?: number;
    /** the scope a forbidden credential lacks, when the API names it */
    readonly scope?: string;
    /** an XML-RPC fault of the interface process */
    readonly faultCode?: number;
    readonly method?: string;
    /** the certificate a `certificate` error is about - for the consumer's trust dialog */
    readonly certificate?: CertificateInfo;
    readonly detail?: unknown;

    constructor(code: string, message: string, extra: {status?: number; scope?: string; faultCode?: number; method?: string; certificate?: CertificateInfo; detail?: unknown} = {}) {
        super(message);
        this.name = 'OccuLiteError';
        this.code = code;
        this.status = extra.status;
        this.scope = extra.scope;
        this.faultCode = extra.faultCode;
        this.method = extra.method;
        this.certificate = extra.certificate;
        this.detail = extra.detail;
    }
}

/** The error of an API answer that is not 2xx: its {error, message} when it has one. */
export function httpError(status: number, body: unknown): OccuLiteError {
    const b = (body && typeof body === 'object' ? body : {}) as {error?: string; message?: string; scope?: string};
    let code = b.error ?? (status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 501 ? 'unsupported' : `http-${status}`);
    let message = b.message ?? `HTTP ${status}`;
    let scope = b.scope;
    if (status === 403 && !scope) {
        const m = /needs? ([a-z]+:[a-z]+|\*)/.exec(message);
        if (m) scope = m[1];
    }
    if (code === 'forbidden' && scope) message += ` (the credential lacks ${scope}: pair again with more access, or grant it in the API tokens panel)`;
    if (code === 'not_found') code = 'not-found';
    return new OccuLiteError(code, message, {status, scope, detail: body});
}
