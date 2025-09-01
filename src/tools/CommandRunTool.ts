import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { Logger } from '../components/Logger';

interface ICommandParams {
    command?: string;
    useLastCommand?: boolean;
    useSelection?: boolean; // run selected text from the active editor
    terminalName?: string;
    captureOutput?: boolean; // if true, run in a pseudoterminal and capture output
}

export class CommandRunTool implements vscode.LanguageModelTool<ICommandParams> {
    private static lastCommand: string | undefined;

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICommandParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const logger = Logger.getInstance();

            // Determine command to run
            let command = options.input.command;
            if (options.input.useLastCommand) {
                command = CommandRunTool.lastCommand;
                if (!command) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No last command available')
                    ]);
                }
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

            // Send command to a visible VS Code terminal so the user can see logs.
            // Avoid sending an explicit `cd` to an existing terminal to prevent
            // accidental concatenation of prior prompt + cd + new command.
            const terminalName = options.input.terminalName || 'Cogent Runner';
            let term = vscode.window.terminals.find(t => t.name === terminalName);
            const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            // If we need to create a new terminal, prefer passing cwd to the
            // terminal creation options so the terminal starts in the workspace.
            if (!term) {
                if (workspaceCwd) {
                    term = vscode.window.createTerminal({ name: terminalName, cwd: workspaceCwd });
                } else {
                    term = vscode.window.createTerminal({ name: terminalName });
                }
            }

            // Show the terminal but do NOT send an explicit `cd` to avoid the
            // case where the terminal prompt and a sent `cd` combine into one line.
            term.show(true);

            // If captureOutput is requested, run the command in a pseudoterminal
            // so the extension can capture stdout/stderr directly. This keeps
            // output separate from any user-visible terminal and avoids relying
            // on APIs that aren't available in all VS Code versions.
            if (options.input.captureOutput) {
                let buffer = '';
                let child: ChildProcess | undefined;

                const emitter = new vscode.EventEmitter<string>();
                const pty: vscode.Pseudoterminal = {
                    onDidWrite: emitter.event,
                    open: () => {
                        try {
                            child = spawn(command, { shell: true, cwd: workspaceCwd });
                            child.stdout?.on('data', (d: Buffer) => {
                                const s = d.toString();
                                buffer += s;
                                emitter.fire(s);
                            });
                            child.stderr?.on('data', (d: Buffer) => {
                                const s = d.toString();
                                buffer += s;
                                emitter.fire(s);
                            });
                            child.on('close', () => {
                                emitter.fire('\n');
                                try { emitter.dispose(); } catch {}
                            });
                        } catch (err) {
                            emitter.fire(`Error spawning process: ${(err as Error).message}`);
                            try { emitter.dispose(); } catch {}
                        }
                    },
                    close: () => {
                        try { child?.kill(); } catch {}
                    }
                };

                const captureTerm = vscode.window.createTerminal({ name: `${terminalName} (capture)`, pty });
                captureTerm.show(true);

                logger.info(`Spawned capture terminal '${terminalName} (capture)' for command: ${command}`);

                // Wait for process to finish or timeout
                const captured = await new Promise<string>((resolve) => {
                    const timeout = setTimeout(() => resolve(buffer), 15000);
                    // Poll for child exit by checking the buffer change; when
                    // the child process ends we'll clear the timeout in a
                    // microtask. Simpler than wiring events here.
                    const check = setInterval(() => {
                        // if terminal emitter disposed, assume finished
                        // There's no direct event here to know; rely on timeout
                    }, 200);
                    // Resolve when timeout fires
                    outputPromiseLike: void 0;
                    // fallback: resolve after timeout
                });

                if (buffer) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Captured terminal output:\n${buffer}`)
                    ]);
                }

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Command sent to capture terminal '${terminalName} (capture)'. Output will appear in that terminal.`)
                ]);
            }

            // Non-capture path: just send the command to the terminal
            term.sendText(command, true);

            logger.info(`Sent command to terminal '${terminalName}': ${command}`);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Command sent to terminal '${terminalName}'. Output will appear in that terminal.`)
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error sending command to terminal: ${(err as Error)?.message}`)
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
