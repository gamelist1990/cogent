import * as vscode from 'vscode';
import { UnsavedChangesDetector } from '../components/UnsavedChangesDetector';
import { Logger } from '../components/Logger';

interface IThinkInput {
    action: string;
    params?: any;
}

export class ThinkTool implements vscode.LanguageModelTool<IThinkInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IThinkInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const logger = Logger.getInstance();
        try {
            const action = options.input.action;

            if (action === 'gather_context') {
                const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
                const openEditors = vscode.window.visibleTextEditors.map(e => ({
                    path: vscode.workspace.asRelativePath(e.document.uri),
                    isDirty: e.document.isDirty,
                    languageId: e.document.languageId,
                    selection: e.selection ? e.document.getText(e.selection) : ''
                }));
                const unsaved = await UnsavedChangesDetector.getAllUnsavedChanges();
                const cfg = vscode.workspace.getConfiguration('cogent');

                const result = {
                    workspaceFolders,
                    openEditors,
                    unsaved,
                    cogentConfig: {
                        use_full_workspace: cfg.get('use_full_workspace'),
                        debug: cfg.get('debug'),
                        commandTimeout: cfg.get('commandTimeout')
                    }
                };

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(result))
                ]);
            }

            if (action === 'get_open_editors') {
                const editors = vscode.window.visibleTextEditors.map(e => ({
                    path: vscode.workspace.asRelativePath(e.document.uri),
                    isDirty: e.document.isDirty,
                    lineCount: e.document.lineCount
                }));
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({ editors }))
                ]);
            }

            if (action === 'get_workspace_folders') {
                const folders = (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, path: f.uri.fsPath }));
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({ folders }))
                ]);
            }

            // Unknown action
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({ error: `Unknown action: ${action}` }))
            ]);

        } catch (err: unknown) {
            const msg = (err instanceof Error) ? err.message : String(err);
            logger.error(`ThinkTool error: ${msg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({ error: msg }))
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IThinkInput>,
        _token: vscode.CancellationToken
    ) {
        return { invocationMessage: `Background think: ${options.input.action}` };
    }
}
