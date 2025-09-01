import * as vscode from 'vscode';
import { Logger } from '../components/Logger';

interface ISemanticSearchInput {
    query?: string;
    maxResults?: number;
}

export class SemanticSearchTool implements vscode.LanguageModelTool<ISemanticSearchInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISemanticSearchInput>,
        _token: vscode.CancellationToken
    ) {
        const logger = Logger.getInstance();
        const q = (options.input.query || '').trim();
        const max = options.input.maxResults || 10;

        logger.info(`Running semantic_search (vscode.search) for query: ${q}`);

        if (!q) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No query')]);
        }

        const results: string[] = [];

        try {
            const includes = '**/*.{ts,tsx,js,jsx,py,java,go,rs,php,cs,json,md}';
            const excludes = '**/node_modules/**';

            // Use workspace.findFiles then read files and search lines manually to remain compatible
            const files = await vscode.workspace.findFiles(includes, excludes, max);
            for (const uri of files) {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(bytes).toString('utf8');
                    const lines = text.split(/\r?\n/);

                    for (let i = 0; i < lines.length && results.length < max; i++) {
                        const lineText = lines[i];
                        if (!lineText) continue;
                        if (lineText.indexOf(q) !== -1) {
                            const preview = lineText.replace(/\t/g, ' ').trim();
                            const entry = `${uri.fsPath}:${i + 1}: ${preview}`;
                            if (!results.includes(entry)) {
                                results.push(entry);
                            }
                        }
                    }
                } catch (e) {
                    // ignore per-file errors
                }
                if (results.length >= max) break;
            }
        } catch (err: unknown) {
            logger.warn(`semantic_search failed: ${(err as Error)?.message}`);
        }

        const body = results.length ? results.join('\n') : 'No results';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)]);
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<ISemanticSearchInput>) {
        return { invocationMessage: 'Performing semantic search (workspace search)' };
    }
}
