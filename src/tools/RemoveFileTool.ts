import * as vscode from 'vscode';
import * as path from 'path';
import { preInvokeHint, postSuccessHint, postErrorHint } from './AgentToolHelpers';

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

            const rawPath = (options.input.path ?? '').toString().trim();
            // Normalize AI-provided paths: treat leading '/' as workspace-relative
            let normalizedRawPath = rawPath;
            if (normalizedRawPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(normalizedRawPath)) {
                normalizedRawPath = normalizedRawPath.replace(/^\/+/, '');
            }

            const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(normalizedRawPath);
            const isAbsolutePath = path.isAbsolute(normalizedRawPath) && !normalizedRawPath.startsWith('/') ? path.isAbsolute(normalizedRawPath) : isWindowsDrive;

            const targetFsPath = isAbsolutePath
                ? path.normalize(normalizedRawPath)
                : path.normalize(path.join(workspaceFolder.uri.fsPath, normalizedRawPath));

            const targetUri = vscode.Uri.file(targetFsPath);

        // Confirm existence
            try {
                await vscode.workspace.fs.stat(targetUri);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(preInvokeHint('RemoveFileTool', options.input.path)),
            new vscode.LanguageModelTextPart(`Path ${options.input.path} does not exist.`),
            new vscode.LanguageModelTextPart(postErrorHint('RemoveFileTool', (err as Error)?.message))
                ]);
            }

            // Use workspace.fs.delete for deletion; allow recursive for directories
            await vscode.workspace.fs.delete(targetUri, { recursive: !!options.input.recursive, useTrash: false });

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('RemoveFileTool', options.input.path)),
                new vscode.LanguageModelTextPart(`Deleted ${options.input.path}`),
                new vscode.LanguageModelTextPart(postSuccessHint('RemoveFileTool'))
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('RemoveFileTool', options.input.path)),
                new vscode.LanguageModelTextPart(postErrorHint('RemoveFileTool', (err as Error)?.message))
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
