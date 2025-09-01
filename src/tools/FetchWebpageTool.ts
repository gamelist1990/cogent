import * as vscode from 'vscode';

let _nodeFetch: any;
async function getFetch() {
    if (typeof (globalThis as any).fetch === 'function') return (globalThis as any).fetch.bind(globalThis);
    if (!_nodeFetch) {
        _nodeFetch = await import('node-fetch');
    }
    return _nodeFetch.default || _nodeFetch;
}

interface IFetchInput {
    url: string;
}

export class FetchWebpageTool implements vscode.LanguageModelTool<IFetchInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFetchInput>,
        _token: vscode.CancellationToken
    ) {
        try {
            const url = options.input.url;
            if (!url) throw new Error('URL is required');
            const _fetch = await getFetch();
            const res = await _fetch(url, { headers: { 'User-Agent': 'cogent/1.0' } });
            const text = await res.text();
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Fetch failed: ${(err as Error)?.message}`)]);
        }
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IFetchInput>) {
        return { invocationMessage: 'Fetching webpage' };
    }
}
