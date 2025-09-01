import * as vscode from 'vscode';
import * as path from 'path';

interface ICreateParams {
    path: string;
    content?: string;
    overwrite?: boolean;
}

export class CreateFileTool implements vscode.LanguageModelTool<ICreateParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICreateParams>,
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

            // Check existence
            let exists = true;
            try {
                await vscode.workspace.fs.stat(targetUri);
            } catch (err) {
                exists = false;
            }

            if (exists && !options.input.overwrite) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Path ${options.input.path} already exists. Set overwrite=true to replace.`)
                ]);
            }

            // Ensure parent directory exists
            const dir = path.dirname(targetUri.fsPath);
            const dirUri = vscode.Uri.file(dir);
            try {
                await vscode.workspace.fs.stat(dirUri);
            } catch (err) {
                // create directories recursively
                await vscode.workspace.fs.createDirectory(dirUri);
            }

            const content = Buffer.from(options.input.content ?? '', 'utf8');
            await vscode.workspace.fs.writeFile(targetUri, content);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Created ${options.input.path}`)
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error creating file: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.createFile', false);
        const message = `Create ${options.input.path}`;
        if (autoConfirm) return { invocationMessage: message };

        return {
            invocationMessage: message,
            confirmationMessages: {
                title: 'Create File',
                message: new vscode.MarkdownString(`${message}?`)
            }
        };
    }
}
