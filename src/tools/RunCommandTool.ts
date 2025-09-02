import * as vscode from 'vscode';
import { preInvokeHint, postSuccessHint, postErrorHint } from './AgentToolHelpers';
import { spawn } from 'child_process';
import * as path from 'path';

export interface IRunCommandParams {
    // Full command string including flags (e.g. "npx @vscode/vsce package --some-flag")
    command: string;
    // Optional working directory (relative to workspace root or absolute path)
    path?: string;
    // Optional timeout in milliseconds
    timeoutMs?: number;
}

export class RunCommandTool implements vscode.LanguageModelTool<IRunCommandParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunCommandParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;
        try {
            if (!input.command) {
                throw new Error('`command` is required');
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            // Resolve working directory from `path` parameter (if provided) against workspace
            let cwd: string;
            if (input.path) {
                const rawPath = String(input.path).trim();
                const isWindowsDrive = /^[a-zA-Z]:\\/.test(rawPath) || /^[a-zA-Z]:\//.test(rawPath);
                const isAbsolutePath = path.isAbsolute(rawPath) || isWindowsDrive;
                if (isAbsolutePath) {
                    cwd = path.normalize(rawPath);
                } else if (workspaceFolder) {
                    cwd = path.normalize(path.join(workspaceFolder.uri.fsPath, rawPath));
                } else {
                    cwd = path.resolve(rawPath);
                }
            } else {
                cwd = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
            }

            // Always run the provided `command` string through a shell so callers may include flags
            const spawnOptions: any = { cwd, shell: true };

            return await new Promise<vscode.LanguageModelToolResult>((resolve) => {
                const child = spawn(input.command, spawnOptions as any);
                let stdout = '';
                let stderr = '';
                let timedOut = false;

                const timeout = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
                    ? setTimeout(() => {
                        timedOut = true;
                        try { child.kill(); } catch (e) { /* ignore */ }
                    }, input.timeoutMs)
                    : null;

                child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
                child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

                child.on('error', (err) => {
                    if (timeout) clearTimeout(timeout);
                    resolve(new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(preInvokeHint('RunCommandTool', input.command)),
                        new vscode.LanguageModelTextPart(postErrorHint('RunCommandTool', err.message))
                    ]));
                });

                child.on('close', (code, signal) => {
                    if (timeout) clearTimeout(timeout);

                    const parts: vscode.LanguageModelTextPart[] = [];
                    parts.push(new vscode.LanguageModelTextPart(preInvokeHint('RunCommandTool', input.command)));

                    if (timedOut) {
                        parts.push(new vscode.LanguageModelTextPart(`Command timed out after ${input.timeoutMs}ms. Partial stdout/stderr included below.`));
                    }

                    parts.push(new vscode.LanguageModelTextPart(`Exit code: ${code ?? 'null'}${signal ? `, signal: ${signal}` : ''}`));

                    const maxPreview = 16 * 1024; // 16KB
                    const safeStdout = stdout.length > maxPreview ? stdout.slice(0, maxPreview) + '\n...[truncated]' : stdout;
                    const safeStderr = stderr.length > maxPreview ? stderr.slice(0, maxPreview) + '\n...[truncated]' : stderr;

                    parts.push(new vscode.LanguageModelTextPart('--- STDOUT ---'));
                    parts.push(new vscode.LanguageModelTextPart(safeStdout || '(no stdout)'));
                    parts.push(new vscode.LanguageModelTextPart('--- STDERR ---'));
                    parts.push(new vscode.LanguageModelTextPart(safeStderr || '(no stderr)'));

                    parts.push(new vscode.LanguageModelTextPart(postSuccessHint('RunCommandTool')));

                    resolve(new vscode.LanguageModelToolResult(parts));
                });
            });

        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('RunCommandTool', options.input?.command)),
                new vscode.LanguageModelTextPart(postErrorHint('RunCommandTool', (err as Error)?.message))
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRunCommandParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.runCommand', false);
        const message = `Run command: ${options.input.command}`;
        if (autoConfirm) return { invocationMessage: message };

        return {
            invocationMessage: message,
            confirmationMessages: {
                title: 'Run Command',
                message: new vscode.MarkdownString(`${message}?\n\nWorking directory: ${options.input.path ?? '(workspace root)'}`)
            }
        };
    }
}
