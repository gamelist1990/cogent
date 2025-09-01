import * as vscode from 'vscode';
// Use dynamic import for node-fetch to avoid ESM/CommonJS issues in some setups
let _nodeFetch: any;
async function getFetch() {
    if (typeof (globalThis as any).fetch === 'function') return (globalThis as any).fetch.bind(globalThis);
    if (!_nodeFetch) {
        _nodeFetch = await import('node-fetch');
    }
    return _nodeFetch.default || _nodeFetch;
}

interface ISearchInput {
    query: string;
    maxResults?: number;
}

export class WebSearchTool implements vscode.LanguageModelTool<ISearchInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISearchInput>,
        _token: vscode.CancellationToken
    ) {
        try {
            const q = encodeURIComponent(options.input.query || '');
            const max = options.input.maxResults || 5;
            // Use DuckDuckGo HTML results as a simple, no-keyword search
            const url = `https://duckduckgo.com/html?q=${q}`;
            const _fetch = await getFetch();
            const res = await _fetch(url, { headers: { 'User-Agent': 'cogent/1.0' } });
            const html = await res.text();

            // Very lightweight scraping: find result anchors
            const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            const results: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = linkRegex.exec(html)) && results.length < max) {
                const href = m[1];
                const title = m[2].replace(/<[^>]+>/g, '').trim();
                results.push(`${title} - ${href}`);
            }

            const body = results.length ? results.join('\n') : 'No results';
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Search failed: ${(err as Error)?.message}`)]);
        }
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchInput>) {
        return { invocationMessage: 'Performing web search' };
    }
}
