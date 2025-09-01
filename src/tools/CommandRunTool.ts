import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { Logger } from '../components/Logger';

interface ICommandParams {
    command?: string;
    useLastCommand?: boolean;
    useSelection?: boolean; // run selected text from the active editor
    terminalName?: string;
}

export class CommandRunTool implements vscode.LanguageModelTool<ICommandParams> {
    private static lastCommand: string | undefined;

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICommandParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const cfgTimeout = vscode.workspace.getConfiguration('cogent').get('commandTimeout', 60) as number;

            // Determine command to run
            let command = options.input.command;
            if (options.input.useLastCommand) {
                command = CommandRunTool.lastCommand;
            }

            if (options.input.useSelection) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active editor with selection')]);
                }
                const sel = editor.selection;
                command = editor.document.getText(sel);
                if (!command) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No selection to run')]);
                }
            }

            if (!command) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No command provided')]);
            }

            // Save last command
            CommandRunTool.lastCommand = command;

            // Execute the command using child_process
            return new Promise<vscode.LanguageModelToolResult>((resolve) => {
                const isWindows = os.platform() === 'win32';
                const shell = isWindows ? 'powershell.exe' : '/bin/bash';
                const execOptions = {
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                    timeout: cfgTimeout * 1000, // milliseconds
                    maxBuffer: 1024 * 1024 * 10 // 10MB buffer
                };

                child_process.exec(command, execOptions, (error, stdout, stderr) => {
                    let result = '';
                    if (stdout) result += `STDOUT:\n${stdout}\n`;
                    if (stderr) result += `STDERR:\n${stderr}\n`;
                    if (error) {
                        result += `ERROR: ${error.message}\n`;
                        if (error.code) result += `Exit Code: ${error.code}\n`;
                    } else {
                        result += `Command completed successfully.\n`;
                    }

                    resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]));
                });
            });
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error executing command: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICommandParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.runCommand', false);
        const preview = options.input.useLastCommand ? '(using last command)' : options.input.useSelection ? '(using selection)' : options.input.command ?? '(no command)';
        if (autoConfirm) {
            return { invocationMessage: `Executing command: ${preview}` };
        }

        return {
            invocationMessage: `Executing command: ${preview}`,
            confirmationMessages: {
                title: 'Run Command',
                message: new vscode.MarkdownString(`Execute command: ${preview}?`)
            }
        };
    }
}