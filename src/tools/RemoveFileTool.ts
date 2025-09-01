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

            const targetUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, options.input.path));

            // Confirm existence
            try {
                await vscode.workspace.fs.stat(targetUri);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Path ${options.input.path} does not exist.`)
                ]);
            }

            // Use workspace.fs.delete for deletion; allow recursive for directories
            await vscode.workspace.fs.delete(targetUri, { recursive: !!options.input.recursive, useTrash: false });

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
