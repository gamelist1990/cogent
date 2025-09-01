import * as vscode from 'vscode';
import * as path from 'path';

interface IEditFileEntry {
    path: string;
    content: string;
    create?: boolean;
}

interface IApiInput {
    action: 'get_terminal_last_command' | 'get_terminal_selection' | 'runCommands' | 'editFiles';
    commands?: string[]; // for runCommands
    edits?: IEditFileEntry[]; // for editFiles
}

export class GetVscodeApiTool implements vscode.LanguageModelTool<IApiInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IApiInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            if (options.input.action === 'get_terminal_last_command') {
                // If CommandRunTool stored last command on its class, attempt to read it
                // Use any to avoid circular import
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const mod = require('./CommandRunTool');
                    const last = mod.CommandRunTool?.lastCommand;
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(last || ''))]);
                } catch (err) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('')]);
                }
            }

            if (options.input.action === 'get_terminal_selection') {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('')]);
                const sel = editor.selection;
                const text = editor.document.getText(sel);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
            }

            if (options.input.action === 'runCommands') {
                const cmds = options.input.commands || [];
                for (const c of cmds) {
                    // Reuse existing terminal run behavior
                    const term = vscode.window.activeTerminal || vscode.window.createTerminal({ name: 'Cogent Runner' });
                    term.show();
                    term.sendText(c, true);
                }
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Commands sent')]);
            }

            if (options.input.action === 'editFiles') {
                const edits = options.input.edits || [];
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No workspace folder found')]);
                }

                for (const e of edits) {
                    try {
                        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, e.path);
                        const dir = path.dirname(e.path);
                        if (dir && dir !== '.') {
                            const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, dir);
                            try {
                                await vscode.workspace.fs.stat(dirUri);
                            } catch {
                                // create directory if missing
                                await vscode.workspace.fs.createDirectory(dirUri);
                            }
                        }

                        const encoder = new TextEncoder();
                        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(e.content));
                    } catch (err) {
                        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Failed to write ${e.path}: ${(err as Error)?.message}`)]);
                    }
                }

                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Wrote ${edits.length} file(s)`)]);
            }

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Unknown action')]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error: ${(err as Error)?.message}`)]);
        }
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IApiInput>) {
        return { invocationMessage: 'Accessing VS Code terminal API' };
    }
}
