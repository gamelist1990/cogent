import * as vscode from 'vscode';
import * as path from 'path';

interface IRemoveParams {
    path: string;
    recursive?: boolean;
}

export class RemoveFileTool implements vscode.LanguageModelTool<IRemoveParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRemoveParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            if (!options.input.path) {
                throw new Error('Path is required');
            }

            const logger = (require('../components/Logger').Logger).getInstance();

            // Normalize input path: accept absolute paths, workspace-relative paths, and file: URIs
            let targetUri: vscode.Uri;
            const raw = options.input.path;
            try {
                if (raw.startsWith('file:')) {
                    targetUri = vscode.Uri.parse(raw);
                } else if (path.isAbsolute(raw)) {
                    targetUri = vscode.Uri.file(raw);
                } else {
                    // Relative to workspace folder
                    targetUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, raw));
                }
            } catch (e) {
                logger.error(`Failed to build target URI from input '${raw}': ${(e as Error).message}`);
                throw e;
            }

            logger.debug(`RemoveFileTool: resolved targetUri=${targetUri.toString()} fsPath=${targetUri.fsPath}`);

            // Confirm existence
            try {
                await vscode.workspace.fs.stat(targetUri);
            } catch (err) {
                logger.warn(`Path does not exist: ${targetUri.toString()} (${(err as Error).message})`);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Path ${options.input.path} does not exist: ${(err as Error).message}`)
                ]);
            }

            // Use workspace.fs.delete for deletion; allow recursive for directories
            try {
                await vscode.workspace.fs.delete(targetUri, { recursive: !!options.input.recursive, useTrash: false });
            } catch (err) {
                logger.error(`Failed to delete ${targetUri.toString()}: ${(err as Error).message}`);
                throw err;
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Deleted ${options.input.path}`)
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error deleting path: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRemoveParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.removeFile', false);
        const message = `Delete ${options.input.path}${options.input.recursive ? ' (recursive)' : ''}`;
        if (autoConfirm) return { invocationMessage: message };

        return {
            invocationMessage: message,
            confirmationMessages: {
                title: 'Delete Path',
                message: new vscode.MarkdownString(`${message}?`)
            }
        };
    }
}
