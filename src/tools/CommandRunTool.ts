import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
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
            const cfgTimeout = vscode.workspace.getConfiguration('cogent').get('commandTimeout', 30) as number;

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

            // Find an existing terminal or create a new one
            const termName = options.input.terminalName || 'Cogent Terminal';
            let terminal = vscode.window.terminals.find(t => t.name === termName);
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: termName });
            }

            // Send the command using the Terminal API
            terminal.show();
            // Use sendText which adds a newline by default when second arg true
            terminal.sendText(command, true);

            // We cannot reliably capture terminal output via API; return ack and saved lastCommand
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Command sent to terminal: ${command}`)
            ]);
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