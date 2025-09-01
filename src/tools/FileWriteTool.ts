import * as vscode from 'vscode';
import * as path from 'path';

interface IFileOperationParams {
    path?: string;
    paths?: string[];
    content?: string;
}

export class FileWriteTool implements vscode.LanguageModelTool<IFileOperationParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFileOperationParams>,
        _token: vscode.CancellationToken
    ) {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspacePath) {
                throw new Error('No workspace folder found');
            }
            if (!options.input.path) {
                throw new Error('File path is required');
            }
            const filePath = path.join(workspacePath, options.input.path);

            // Use VS Code workspace FS APIs to create the file if it doesn't exist
            const fileUri = vscode.Uri.file(filePath);
            try {
                await vscode.workspace.fs.stat(fileUri);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `File ${options.input.path} already exists. To modify existing files, please use 'cogent_updateFile' or 'cogent_applyDiff' tools.`
                    )
                ]);
            } catch {
                // File doesn't exist, proceed with creation using workspace.fs
                const encoder = new TextEncoder();
                const data = encoder.encode(options.input.content || '');
                await vscode.workspace.fs.writeFile(fileUri, data);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`File created successfully at ${options.input.path}`)
                ]);
            }
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error writing file: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFileOperationParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.writeFile', false);
        
        if (autoConfirm) {
            return {
                invocationMessage: `Creating new file at ${options.input.path}`
            };
        }

        return {
            invocationMessage: `Creating new file at ${options.input.path}`,
            confirmationMessages: {
                title: 'Create New File',
                message: new vscode.MarkdownString(`Create a new file at ${options.input.path}?`)
            }
        };
    }
}