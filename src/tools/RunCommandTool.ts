import * as vscode from 'vscode';
import { preInvokeHint, postSuccessHint, postErrorHint } from './AgentToolHelpers';
import { spawn } from 'child_process';

export interface IRunCommandParams {
    command: string;
    args?: string[];
    cwd?: string;
    shell?: boolean | string;
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
            const cwd = input.cwd
                ? (workspaceFolder ? vscode.Uri.joinPath(workspaceFolder.uri, input.cwd).fsPath : input.cwd)
                : (workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd());

            // Build spawn options
            const spawnOptions: any = { cwd };
            if (typeof input.shell !== 'undefined') spawnOptions.shell = input.shell;

            return await new Promise<vscode.LanguageModelToolResult>((resolve) => {
                const child = spawn(input.command, input.args || [], spawnOptions);
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

                    // Provide a compact summary and full outputs as separate parts so the assistant
                    // can reference the result safely.
                    const parts: vscode.LanguageModelTextPart[] = [];
                    parts.push(new vscode.LanguageModelTextPart(preInvokeHint('RunCommandTool', input.command)));

                    if (timedOut) {
                        parts.push(new vscode.LanguageModelTextPart(`Command timed out after ${input.timeoutMs}ms. Partial stdout/stderr included below.`));
                    }

                    // Summary
                    parts.push(new vscode.LanguageModelTextPart(`Exit code: ${code ?? 'null'}${signal ? `, signal: ${signal}` : ''}`));

                    // Truncate long outputs to avoid streaming huge blobs; include lengths
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
        const cmd = `${options.input.command} ${ (options.input.args || []).join(' ') }`;
        const message = `Run command: ${cmd}`;
        if (autoConfirm) return { invocationMessage: message };

        return {
            invocationMessage: message,
            confirmationMessages: {
                title: 'Run Command',
                message: new vscode.MarkdownString(`${message}?\n\nWorking directory: ${options.input.cwd ?? '(workspace root)'}`)
            }
        };
    }
}
