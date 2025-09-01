import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../components/Logger';

interface IPathParams {
    path: string;
}

export class GetAbsolutePathTool implements vscode.LanguageModelTool<IPathParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IPathParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const logger = Logger.getInstance();
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) throw new Error('No workspace folder found');
            if (!options.input.path) throw new Error('Path is required');

            const raw = options.input.path;
            let targetFsPath: string;
            if (raw.startsWith('file:')) {
                const uri = vscode.Uri.parse(raw);
                targetFsPath = uri.fsPath;
            } else if (path.isAbsolute(raw)) {
                targetFsPath = raw;
            } else {
                targetFsPath = path.join(workspaceFolder.uri.fsPath, raw);
            }

            logger.debug(`GetAbsolutePathTool: ${raw} -> ${targetFsPath}`);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(targetFsPath)
            ]);
        } catch (err: unknown) {
            const msg = (err instanceof Error) ? err.message : String(err);
            Logger.getInstance().error(`GetAbsolutePathTool error: ${msg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error resolving path: ${msg}`)
            ]);
        }
    }
}
