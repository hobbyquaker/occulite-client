// A Server-Sent Events parser over a byte stream: the stream is read with fetch or node:https and
// parsed here, because EventSource cannot send a header credential (D-115) and does not exist in
// Node. Comments (": ping") are counted as life; every message is {id, event, data}.

export interface SSEMessage {
    id?: string;
    event: string;
    data: string;
}

export async function* parseSSE(chunks: AsyncIterable<Uint8Array>, onComment?: () => void): AsyncGenerator<SSEMessage> {
    const dec = new TextDecoder();
    let buf = '';
    let id: string | undefined;
    let event = '';
    let data: string[] = [];
    for await (const chunk of chunks) {
        buf += dec.decode(chunk, {stream: true});
        let nl: number;
        while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
            if (line === '') {
                if (data.length) yield {id, event: event || 'message', data: data.join('\n')};
                id = undefined;
                event = '';
                data = [];
                continue;
            }
            if (line.startsWith(':')) {
                onComment?.();
                continue;
            }
            const c = line.indexOf(':');
            const field = c < 0 ? line : line.slice(0, c);
            let value = c < 0 ? '' : line.slice(c + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'data') data.push(value);
            else if (field === 'event') event = value;
            else if (field === 'id') id = value;
        }
    }
}
