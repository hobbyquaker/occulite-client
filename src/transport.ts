// How the client talks HTTP: a small interface with two implementations - fetch (browsers, and
// Node when no certificate is pinned) and node:https (occulite-client/node: pinning a self-signed
// certificate per connection, which Node's fetch does not take without undici).

import {OccuLiteError, abortError, transportReason} from './errors.ts';

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface Transport {
    request(method: string, url: string, headers: Record<string, string>, body?: string, signal?: AbortSignal): Promise<TransportResponse>;
    /** a long-lived GET whose body arrives in chunks (the event streams) */
    stream(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{status: number; chunks: AsyncIterable<Uint8Array>; body?: string}>;
}

/** The fetch transport. */
export function fetchTransport(f: typeof fetch = globalThis.fetch): Transport {
    return {
        async request(method, url, headers, body, signal) {
            let r: Response;
            try {
                r = await f(url, {method, headers, body, signal, credentials: 'same-origin'});
            } catch (e) {
                if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError') throw abortError(signal);
                const cause = ((e as Error & {cause?: unknown}).cause ?? e) as {code?: string; message?: string; name?: string};
                throw new OccuLiteError('unreachable', `the system does not answer: ${(e as Error).message}`, {detail: {code: transportReason(cause)}});
            }
            const h: Record<string, string> = {};
            r.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
            return {status: r.status, headers: h, body: await r.text()};
        },
        async stream(url, headers, signal) {
            let r: Response;
            try {
                r = await f(url, {headers: {...headers, Accept: 'text/event-stream'}, signal, credentials: 'same-origin'});
            } catch (e) {
                if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError') throw abortError(signal, 'the stream');
                const cause = ((e as Error & {cause?: unknown}).cause ?? e) as {code?: string; message?: string; name?: string};
                throw new OccuLiteError('unreachable', `the system does not answer: ${(e as Error).message}`, {detail: {code: transportReason(cause)}});
            }
            if (r.status !== 200 || !r.body) return {status: r.status, chunks: (async function* () {})(), body: await r.text()};
            const reader = r.body.getReader();
            return {
                status: 200,
                chunks: {
                    async *[Symbol.asyncIterator]() {
                        try {
                            for (;;) {
                                const {value, done} = await reader.read();
                                if (done) return;
                                if (value) yield value;
                            }
                        } finally {
                            reader.releaseLock();
                        }
                    },
                },
            };
        },
    };
}
