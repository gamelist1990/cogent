import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './Logger';

export class DiffView {
    private static readonly scheme = 'cogent-diff';
    private static contentProvider: vscode.TextDocumentContentProvider;
    private static registration: vscode.Disposable;
    private static content = new Map<string, string>();
    private static emitter = new vscode.EventEmitter<vscode.Uri>();

    private originalUri: vscode.Uri;
    private modifiedUri: vscode.Uri;
    private document?: vscode.TextDocument;
    private disposables: vscode.Disposable[] = [];

    constructor(filePath: string, originalContent: string, modifiedContent: string, metadata?: { similarity?: number; matchedRange?: { start: number; end: number }; search?: string; threshold?: number }) {
        this.originalUri = vscode.Uri.file(filePath);
        // Use query param to ensure unique uri so provider updates refresh the diff view
        this.modifiedUri = this.originalUri.with({ scheme: DiffView.scheme, query: String(Date.now()) });

        // Initialize static content provider if not exists
        if (!DiffView.contentProvider) {
            DiffView.contentProvider = {
                provideTextDocumentContent: (uri: vscode.Uri) => {
                    return DiffView.content.get(uri.toString()) || '';
                },
                onDidChange: DiffView.emitter.event
            };
            DiffView.registration = vscode.workspace.registerTextDocumentContentProvider(
                DiffView.scheme,
                DiffView.contentProvider
            );
        }

        // Store the modified content with metadata header for richer preview
        const headerLines: string[] = [];
        headerLines.push(`// Cogent Diff Preview: ${path.basename(filePath)}`);
        if (metadata) {
            if (typeof metadata.similarity === 'number') headerLines.push(`// Similarity: ${(metadata.similarity * 100).toFixed(1)}%`);
            if (metadata.matchedRange) headerLines.push(`// Matched lines: ${metadata.matchedRange.start}-${metadata.matchedRange.end}`);
            if (typeof metadata.threshold === 'number') headerLines.push(`// Required threshold: ${(metadata.threshold * 100).toFixed(1)}%`);
            if (metadata.search) {
                headerLines.push(`// Search excerpt:`);
                headerLines.push(`// ${metadata.search.split('\n').slice(0,5).map(l => l.replace(/\r?\n/g,' ')).join(' | ')}`);
            }
        }
        headerLines.push('');

        DiffView.content.set(this.modifiedUri.toString(), `${headerLines.join('\n')}\n${modifiedContent}`);
    }

    async show(): Promise<boolean> {
        try {
            const logger = Logger.getInstance();
            // Open the file first (ensures document exists in editor context)
            this.document = await vscode.workspace.openTextDocument(this.originalUri);

            // Add save listener
            this.disposables.push(
                vscode.workspace.onDidSaveTextDocument(async doc => {
                    if (doc.uri.toString() === this.originalUri.toString()) {
                        await this.close();
                        // Show the saved file
                        const document = await vscode.workspace.openTextDocument(this.originalUri);
                        await vscode.window.showTextDocument(document, {
                            preview: false,
                            viewColumn: vscode.ViewColumn.Active
                        });
                    }
                })
            );

            // Show diff editor (side-by-side preferred)
            await vscode.commands.executeCommand('vscode.diff',
                this.modifiedUri,
                this.originalUri,
                `${path.basename(this.originalUri.fsPath)} (Preview)`,
                { preview: true }
            );

            return true;
        } catch (error) {
            const logger = Logger.getInstance();
            logger.error(`Failed to open diff view: ${error}`);
            return false;
        }
    }

    /**
     * Update the modified pane content and emit change so the diff view refreshes
     */
    update(modifiedContent: string, metadata?: { similarity?: number; matchedRange?: { start: number; end: number }; search?: string; threshold?: number }) {
        if (!this.modifiedUri) return;
        const headerLines: string[] = [];
        headerLines.push(`// Cogent Diff Preview: ${path.basename(this.originalUri.fsPath)}`);
        if (metadata) {
            if (typeof metadata.similarity === 'number') headerLines.push(`// Similarity: ${(metadata.similarity * 100).toFixed(1)}%`);
            if (metadata.matchedRange) headerLines.push(`// Matched lines: ${metadata.matchedRange.start}-${metadata.matchedRange.end}`);
            if (typeof metadata.threshold === 'number') headerLines.push(`// Required threshold: ${(metadata.threshold * 100).toFixed(1)}%`);
            if (metadata.search) {
                headerLines.push(`// Search excerpt:`);
                headerLines.push(`// ${metadata.search.split('\n').slice(0,5).map(l => l.replace(/\r?\n/g,' ')).join(' | ')}`);
            }
        }
        headerLines.push('');

        DiffView.content.set(this.modifiedUri.toString(), `${headerLines.join('\n')}\n${modifiedContent}`);
        // Emit change event for the modified uri so VS Code refreshes the diff editor
        DiffView.emitter.fire(this.modifiedUri);
    }

    async close() {
        // Clean up the stored content
        DiffView.content.delete(this.modifiedUri.toString());
        // Dispose all listeners
        this.disposables.forEach(d => d.dispose());
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    static dispose() {
        if (DiffView.registration) {
            DiffView.registration.dispose();
        }
        DiffView.content.clear();
        DiffView.emitter.dispose();
    }
}
