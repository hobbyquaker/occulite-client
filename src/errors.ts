// One error class for everything the client reports: the API's own codes (unauthenticated,
// forbidden, too-many-streams, unknown-interface, down, unsupported, the metadata codes) and the
// client's (unreachable, timeout, aborted, certificate, rpc-fault, protocol).

/** One certificate as a trust dialog shows it (the subject's CN, the issuer's CN, the SHA-256,
 *  the validity as OpenSSL prints it, the names) - and its PEM, for a store. */
export interface CertificateInfo {
    subject?: string;
    issuer?: string;
    /** SHA-256, `AB:CD:…` */
    fingerprint256?: string;
    /** as OpenSSL prints it: `Dec 24 12:00:00 2026 GMT` */
    validFrom?: string;
    validTo?: string;
    /** `DNS:lab.example, IP Address:10.0.0.2`, when the certificate has any */
    altNames?: string;
    /** true for a certificate authority */
    ca?: boolean;
    pem?: string;
}

export class OccuLiteError extends Error {
    readonly code: string;
    readonly status?: number;
    /** the scope a forbidden credential lacks, when the API names it */
    readonly scope?: string;
    /** an XML-RPC fault of the interface process */
    readonly faultCode?: number;
    readonly method?: string;
    /** the certificate a `certificate` error is about (the leaf) - for the consumer's trust dialog */
    readonly certificate?: CertificateInfo;
    /** the chain the system sent, the leaf first, as far as it went */
    readonly chain?: CertificateInfo[];
    /** the topmost authority in that chain, with its PEM: what a consumer's *Trust the CA* stores.
     *  Absent for a self-signed certificate (pin its fingerprint instead) */
    readonly ca?: CertificateInfo & {pem: string};
    readonly detail?: unknown;

    /** an `unreachable` error's cause: refused, dns, reset, timeout, or the OS error code; a
     *  `certificate` error's: `pin` for the pinned fingerprint not matching, else Node's code
     *  (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`,
     *  `ERR_TLS_CERT_ALTNAME_INVALID`, …) */
    get reason(): string | undefined {
        const d = this.detail as {code?: string} | undefined;
        return typeof d?.code === 'string' ? d.code : undefined;
    }

    constructor(code: string, message: string, extra: {status?: number; scope?: string; faultCode?: number; method?: string; certificate?: CertificateInfo; chain?: CertificateInfo[]; ca?: CertificateInfo & {pem: string}; detail?: unknown} = {}) {
        super(message);
        this.name = 'OccuLiteError';
        this.code = code;
        this.status = extra.status;
        this.scope = extra.scope;
        this.faultCode = extra.faultCode;
        this.method = extra.method;
        this.certificate = extra.certificate;
        this.chain = extra.chain;
        this.ca = extra.ca;
        this.detail = extra.detail;
    }
}

/** The error of an API answer that is not 2xx: its {error, message} when it has one. */
export function httpError(status: number, body: unknown): OccuLiteError {
    const b = (body && typeof body === 'object' ? body : {}) as {error?: string; message?: string; scope?: string; detail?: unknown};
    let code = b.error ?? (status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 501 ? 'unsupported' : `http-${status}`);
    let message = b.message ?? `HTTP ${status}`;
    let scope = b.scope;
    if (status === 403 && !scope) {
        const m = /needs? ([a-z]+:[a-z]+|\*)/.exec(message);
        if (m) scope = m[1];
    }
    if (code === 'forbidden' && scope) message += ` (the credential lacks ${scope}: pair again with more access, or grant it in the API tokens panel)`;
    if (code === 'not_found') code = 'not-found';
    // the API's own detail (has-members' refs, an import's error location) when it has one, else the whole body
    return new OccuLiteError(code, message, {status, scope, detail: b.detail ?? body});
}

/** The client's word for a transport error: refused, dns, reset, timeout, or the OS code as it is. */
export function transportReason(e: {code?: string; message?: string; name?: string}): string {
    const c = e.code ?? '';
    if (c === 'ECONNREFUSED') return 'refused';
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NONAME') return 'dns';
    if (c === 'ECONNRESET' || c === 'EPIPE') return 'reset';
    if (c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'timeout';
    if (e.name === 'TimeoutError') return 'timeout';
    return c || 'error';
}

/** The error for an aborted request: `timeout` when the signal's reason is a timeout (AbortSignal.timeout()
 *  or the client's own timer), else `aborted` (the consumer's signal). */
export function abortError(signal: AbortSignal | undefined, what = 'the request'): OccuLiteError {
    const r = signal?.reason as {name?: string; code?: string} | undefined;
    if (r?.name === 'TimeoutError' || r?.code === 'timeout') return new OccuLiteError('timeout', `${what} timed out`, {detail: {code: 'timeout'}});
    return new OccuLiteError('aborted', `${what} was aborted`, {detail: {code: 'aborted'}});
}

/** A signal that fires after ms (its reason a TimeoutError), combined with the others given. */
export function timeoutSignal(ms: number | undefined, ...others: (AbortSignal | undefined)[]): AbortSignal | undefined {
    const list = others.filter((s): s is AbortSignal => !!s);
    if (ms && ms > 0) list.push(AbortSignal.timeout(ms));
    if (!list.length) return undefined;
    return list.length === 1 ? list[0] : AbortSignal.any(list);
}
