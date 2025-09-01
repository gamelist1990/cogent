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
        const q = options.input.query || '';
        const max = options.input.maxResults || 10;

        logger.info(`Running semantic_search (lightweight) for query: ${q}`);

        // Lightweight fallback: use VS Code workspace grep to find files containing the query.
        if (!q) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No query')]);
        }

        const results: string[] = [];
        try {
            const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 200);
            for (const uri of uris) {
                if (results.length >= max) break;
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const text = doc.getText();
                    if (text.includes(q)) {
                        const excerpt = text.split('\n').slice(0, 20).join('\n');
                        results.push(`${uri.fsPath}: contains query`);
                    }
                } catch {}
            }
        } catch (err) {
            logger.warn(`semantic_search failed: ${(err as Error).message}`);
        }

        const body = results.length ? results.join('\n') : 'No results';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)]);
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<ISemanticSearchInput>) {
        return { invocationMessage: 'Performing semantic search' };
    }
}
