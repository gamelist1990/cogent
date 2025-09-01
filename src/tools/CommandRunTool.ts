import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
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

            // Run the command in a pseudoterminal and stream stdout/stderr to
            // a visible terminal while buffering the data for the AI. This is
            // the single, consistent execution mode.
            const terminalName = options.input.terminalName || 'Cogent Runner';
            const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            // バッファ上限を設け、端末出力の正規化と自動 dispose を抑制する
            const MAX_BUFFER = 200_000;
            let buffer = '';
            let child: ChildProcess | undefined;

            let resolveExit: ((code: number) => void) | undefined;
            const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });

            const emitter = new vscode.EventEmitter<string>();
            const pty: vscode.Pseudoterminal = {
                onDidWrite: emitter.event,
                open: () => {
                    try {
                        child = spawn(command, { shell: true, cwd: workspaceCwd });

                        const writeChunk = (d: Buffer) => {
                            let s = d.toString();
                            // normalize newlines to CRLF to avoid terminal formatting bugs
                            s = s.replace(/\r\n|\n|\r/g, '\\r\\n');
                            buffer += s;
                            if (buffer.length > MAX_BUFFER) {
                                buffer = buffer.slice(-MAX_BUFFER);
                            }
                            try { emitter.fire(s); } catch {}
                        };

                        child.stdout?.on('data', writeChunk);
                        child.stderr?.on('data', writeChunk);

                        child.on('close', (code) => {
                            try { emitter.fire('\r\n'); } catch {}
                            // 重要: emitter.dispose() / terminal.dispose() は行わず
                            // ユーザーが出力を確認できるようにする
                            resolveExit?.(typeof code === 'number' ? code : 0);
                        });
                    } catch (err) {
                        const msg = `Error spawning process: ${(err as Error).message}\r\n`;
                        try { emitter.fire(msg); } catch {}
                        resolveExit?.(-1);
                    }
                },
                close: () => {
                    try { child?.kill(); } catch {}
                }
            };

            const streamTerm = vscode.window.createTerminal({ name: `${terminalName} (stream)`, pty });
            streamTerm.show(true);

            logger.info(`Started streaming terminal '${terminalName} (stream)' for command: ${command}`);

            // Wait for process to finish or timeout
            const exitCode = await Promise.race([
                exitPromise,
                new Promise<number>((resolve) => setTimeout(() => {
                    try { child?.kill(); } catch {}
                    resolve(-1);
                }, 60000))
            ]);

            // ターミナルは自動で破棄しない。ユーザーが手動で閉じられるようにする。

            logger.info(`Streaming process finished with code ${exitCode} for command: ${command}`);

            if (buffer) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Captured output:\n${buffer}`)
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Command finished with code ${exitCode}, no output was captured.`)
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
