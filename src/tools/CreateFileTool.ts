import * as vscode from 'vscode';
import * as path from 'path';
import { preInvokeHint, postSuccessHint, postErrorHint } from './AgentToolHelpers';

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
            const rawPath = (options.input.path ?? '').toString().trim();
            if (!rawPath) {
                throw new Error('Path is required (provide a path relative to the workspace root)');
            }
            // Determine target filesystem path. Allow absolute paths if explicitly configured.
            const isWindowsDrive = /^[a-zA-Z]:\\/.test(rawPath) || /^[a-zA-Z]:\//.test(rawPath);
            const isAbsolutePath = path.isAbsolute(rawPath) || isWindowsDrive;

            let targetFsPath: string;
            if (isAbsolutePath) {
                targetFsPath = path.normalize(rawPath);
            } else {
                targetFsPath = path.normalize(path.resolve(workspaceFolder.uri.fsPath, rawPath));
            }

            const relative = path.relative(workspaceFolder.uri.fsPath, targetFsPath);
            const outsideWorkspace = relative.startsWith('..') || (relative === '' && isAbsolutePath && path.normalize(targetFsPath) !== path.normalize(path.resolve(workspaceFolder.uri.fsPath)));

            if (outsideWorkspace) {
                const allowExternal = vscode.workspace.getConfiguration('cogent').get('allowExternalFileCreation', false);
                if (!allowExternal) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            'Refusing to create files outside the workspace root. To allow this, enable `cogent.allowExternalFileCreation` in settings.'
                        )
                    ]);
                }
            }

            const targetUri = vscode.Uri.file(targetFsPath);

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

            // Ensure parent directory exists (create if necessary)
            const dir = path.dirname(targetUri.fsPath);
            const dirUri = vscode.Uri.file(dir);
            const dirRoot = path.parse(dir).root;
            // Avoid attempting to create the drive root itself (e.g., "C:\")
            if (dir !== dirRoot) {
                try {
                    await vscode.workspace.fs.stat(dirUri);
                } catch (err) {
                    // create directories recursively
                    await vscode.workspace.fs.createDirectory(dirUri);
                }
            }

            const content = Buffer.from(options.input.content ?? '', 'utf8');
            await vscode.workspace.fs.writeFile(targetUri, content);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('CreateFileTool', options.input.path)),
                new vscode.LanguageModelTextPart(`Created file at ${options.input.path}`),
                new vscode.LanguageModelTextPart(postSuccessHint('CreateFileTool'))
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('CreateFileTool', options.input.path)),
                new vscode.LanguageModelTextPart(postErrorHint('CreateFileTool', (err as Error)?.message))
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
