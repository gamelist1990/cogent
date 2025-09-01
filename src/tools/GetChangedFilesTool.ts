import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';
const execAsync = util.promisify(exec);

export class GetChangedFilesTool implements vscode.LanguageModelTool<unknown> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<unknown>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const cwd = workspaceFolder.uri.fsPath;

            // Use git status --porcelain to get modified/untracked files
            const { stdout } = await execAsync('git status --porcelain', { cwd });
            const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
            const files: string[] = [];

            for (const line of lines) {
                // Format: XY <path> or '?? <path>' for untracked
                // We take everything after the 3rd character, and for rename entries (->) take the destination
                const maybe = line.length > 3 ? line.slice(3) : '';
                if (!maybe) continue;
                const arrowIndex = maybe.indexOf('->');
                const filePath = arrowIndex >= 0 ? maybe.slice(arrowIndex + 2).trim() : maybe.trim();
                files.push(filePath);
            }

            const resultText = files.length ? files.join('\n') : '(no changed files)';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(resultText)
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error getting changed files: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
        _token: vscode.CancellationToken
    ) {
        return { invocationMessage: 'Listing changed files via git status' };
    }
}
