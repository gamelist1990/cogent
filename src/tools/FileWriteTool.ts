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
                const content = options.input.content || '';

                // Try to extract a candidate symbol from content for usage lookup
                const candidate = extractCandidateSymbol(content);
                let usagesText = '';
                if (candidate) {
                    try {
                        const token = new vscode.CancellationTokenSource().token;
                        const res = await vscode.lm.invokeTool('cogent_getVscodeApi', { input: { action: 'list_code_usages', symbol: { name: candidate } }, toolInvocationToken: undefined }, token);
                        const anyRes: any = res;
                        usagesText = (anyRes?.parts ?? []).map((p: any) => p?.text ?? p?.value ?? '').join('\n') ?? '';
                    } catch {
                        // ignore lookup errors
                    }
                }

                const encoder = new TextEncoder();
                const data = encoder.encode(content);
                await vscode.workspace.fs.writeFile(fileUri, data);

                const parts = [new vscode.LanguageModelTextPart(`File created successfully at ${options.input.path}`)];
                if (usagesText) {
                    parts.push(new vscode.LanguageModelTextPart(`Detected symbol '${candidate}' usages:\n${usagesText}`));
                }

                return new vscode.LanguageModelToolResult(parts);
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

// Heuristic to pick a candidate symbol name from provided content
function extractCandidateSymbol(content: string): string | undefined {
    if (!content) return undefined;
    // Try common patterns: function, class, def
    const fnMatch = content.match(/(?:function|def)\s+([A-Za-z_][\w]*)/);
    if (fnMatch) return fnMatch[1];
    const classMatch = content.match(/class\s+([A-Za-z_][\w]*)/);
    if (classMatch) return classMatch[1];
    // Fallback: first identifier with length >=3
    const idMatch = content.match(/\b([A-Za-z_][\w]{2,})\b/);
    return idMatch ? idMatch[1] : undefined;
}
