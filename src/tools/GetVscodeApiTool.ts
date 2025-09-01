import * as vscode from 'vscode';
import * as path from 'path';

interface IEditFileEntry {
    path: string;
    content: string;
    create?: boolean;
}

interface IApiInput {
    action: 'get_terminal_last_command' | 'get_terminal_selection' | 'runCommands' | 'editFiles' | 'list_code_usages';
    commands?: string[]; // for runCommands
    edits?: IEditFileEntry[]; // for editFiles
    // for list_code_usages
    symbol?: {
        uri?: string; // file uri (optional)
        position?: { line: number; character: number }; // optional position in file
        name?: string; // symbol name as fallback
    };
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

            if (options.input.action === 'list_code_usages') {
                try {
                    const sym = options.input.symbol;
                    if (!sym) {
                        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No symbol provided')]);
                    }

                    // If a uri+position is provided, use reference provider
                    const results: string[] = [];
                    if (sym.uri && sym.position) {
                        const uri = vscode.Uri.parse(sym.uri);
                        const pos = new vscode.Position(sym.position.line, sym.position.character);
                        // Use the reference provider command
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos) as vscode.Location[] | undefined;
                        if (refs) {
                            for (const r of refs) {
                                results.push(`${r.uri.fsPath}:${r.range.start.line + 1}:${r.range.start.character + 1}`);
                            }
                        }
                        // Also try definition provider
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, pos) as vscode.Location[] | undefined;
                        if (defs) {
                            for (const d of defs) {
                                results.push(`def: ${d.uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1}`);
                            }
                        }
                    } else if (sym.name) {
                        // Fallback: search workspace for symbol name occurrences
                        const wf = vscode.workspace.workspaceFolders?.[0];
                        if (!wf) {
                            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No workspace folder')]);
                        }
                        // Very simple text search across files
                        const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,java,go,rs,php,cs}', '**/node_modules/**');
                        for (const f of files) {
                            try {
                                const bytes = await vscode.workspace.fs.readFile(f);
                                const text = bytes.toString();
                                const lines = text.split('\n');
                                for (let i = 0; i < lines.length; i++) {
                                    if (lines[i].includes(sym.name)) {
                                        results.push(`${f.fsPath}:${i + 1}`);
                                    }
                                }
                            } catch { /* ignore read errors */ }
                        }
                    }

                    if (results.length === 0) {
                        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No references or definitions found')]);
                    }

                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(results.join('\n'))]);
                } catch (err) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`list_code_usages failed: ${(err as Error).message}`)]);
                }
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
