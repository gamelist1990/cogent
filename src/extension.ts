import * as vscode from 'vscode';
import { registerToolUserChatParticipant } from './toolParticipant';
import { FileReadTool, FileWriteTool, FileUpdateTool, CommandRunTool, ApplyDiffTool, RemoveFileTool, GetChangedFilesTool, WebSearchTool, FetchWebpageTool, GetVscodeApiTool, ThinkTool, SemanticSearchTool } from './tools';
import { DiffView } from './components/DiffView';
import { Logger } from './components/Logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('Cogent extension is now active!');

    // Register tools
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_readFile', new FileReadTool()),
        vscode.lm.registerTool('cogent_writeFile', new FileWriteTool()),
        vscode.lm.registerTool('cogent_updateFile', new FileUpdateTool()),
        vscode.lm.registerTool('cogent_runCommand', new CommandRunTool()),
        vscode.lm.registerTool('cogent_applyDiff', new ApplyDiffTool()),
        vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool()),
        vscode.lm.registerTool('cogent_getChangedFiles', new GetChangedFilesTool()),
        vscode.lm.registerTool('cogent_webSearch', new WebSearchTool()),
        vscode.lm.registerTool('cogent_fetchWebpage', new FetchWebpageTool()),
        vscode.lm.registerTool('cogent_getVscodeApi', new GetVscodeApiTool()),
        vscode.lm.registerTool('cogent_think', new ThinkTool()),
        vscode.lm.registerTool('cogent_semanticSearch', new SemanticSearchTool())
    );



    // Register the tool participant
    registerToolUserChatParticipant(context);

    // Optionally run semantic search on activate if configured
    const autoRun = vscode.workspace.getConfiguration('cogent').get('autoRunSemanticSearchOnActivate', false);
    if (autoRun) {
        const query = String(vscode.workspace.getConfiguration('cogent').get('autoRunSemanticSearchQuery', 'TODO'));
        (async () => {
            try {
                const token = new vscode.CancellationTokenSource().token;
                const res = await vscode.lm.invokeTool('cogent_semanticSearch', { input: { query, maxResults: 10 }, toolInvocationToken: undefined }, token);
                // LanguageModelToolResult may contain parts; stringify safely
                try {
                    const parts: any = res;
                    const text = (parts?.parts ?? parts?.map?.((p: any) => p?.text ?? p?.value ?? String(p)).join('\n')) || String(res);
                    logger.info('Auto semantic_search results: ' + text);
                } catch (e) {
                    logger.info('Auto semantic_search finished');
                }
            } catch (err: unknown) {
                logger.warn('Auto semantic_search failed: ' + ((err as Error)?.message ?? String(err)));
            }
        })();
    }
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}
