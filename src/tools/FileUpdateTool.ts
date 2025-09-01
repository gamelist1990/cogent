import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DiffView } from '../components/DiffView';
import { UnsavedChangesDetector } from '../components/UnsavedChangesDetector';

interface IFileOperationParams {
    path?: string;
    paths?: string[];
    content?: string;
}

export class FileUpdateTool implements vscode.LanguageModelTool<IFileOperationParams> {
    private diffView?: DiffView;

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

            // Prevent operating on directories
            try {
                const stat = await fs.stat(filePath);
                if (stat.isDirectory()) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Path ${options.input.path} is a directory. Please provide a file path.`)
                    ]);
                }
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error accessing path ${options.input.path}: ${(err as Error)?.message}`)
                ]);
            }

            // Check for unsaved changes first
            const unsavedChanges = await UnsavedChangesDetector.detectChanges(options.input.path);
            const currentContent = unsavedChanges.editorContent || await fs.readFile(filePath, 'utf-8');
            
            // Check if file is too large using current content
            const lineCount = currentContent.split('\n').length;
            if (lineCount > 200) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        "This file exceeds 200 lines. Please retry the operation using the 'cogent_applyDiff' tool instead for better handling of large file modifications."
                    )
                ]);
            }

            // For small files, perform an editor-free write using the GetVscodeApiTool 'editFiles' action
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    throw new Error('No workspace folder found');
                }
                // Use the language model tools invocation to call our own API tool
                const relPath = options.input.path;
                const edits = [{ path: relPath!, content: options.input.content ?? currentContent }];
                // toolInvocationToken is optional; pass undefined
                const token = new vscode.CancellationTokenSource().token;
                await vscode.lm.invokeTool('cogent_getVscodeApi', { input: { action: 'editFiles', edits }, toolInvocationToken: undefined }, token);

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Wrote changes to ${options.input.path} using editFiles API.`)
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error updating file via editFiles: ${(err as Error)?.message}`)
                ]);
            }
        } catch (err: unknown) {
            if (this.diffView) {
                await this.diffView.close();
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error updating file: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFileOperationParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.updateFile', false);
        
        if (autoConfirm) {
            return {
                invocationMessage: `Updating file: ${options.input.path}`
            };
        }

        return {
            invocationMessage: `Updating file: ${options.input.path}`,
            confirmationMessages: {
                title: 'Update File',
                message: new vscode.MarkdownString(`Update contents of ${options.input.path}?`)
            }
        };
    }
}