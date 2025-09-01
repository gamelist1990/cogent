import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../components/Logger';

interface IOverwriteParams {
    path: string;
    content: string;
}

export class OverwriteFileTool implements vscode.LanguageModelTool<IOverwriteParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IOverwriteParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const logger = Logger.getInstance();
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) throw new Error('No workspace folder found');
            if (!options.input.path) throw new Error('Path is required');

            const raw = options.input.path;
            let targetUri: vscode.Uri;
            if (raw.startsWith('file:')) {
                targetUri = vscode.Uri.parse(raw);
            } else if (path.isAbsolute(raw)) {
                targetUri = vscode.Uri.file(raw);
            } else {
                targetUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, raw));
            }

            logger.debug(`OverwriteFileTool: resolved targetUri=${targetUri.toString()}`);

            // Ensure parent directory exists
            const parent = path.dirname(targetUri.fsPath);
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
            } catch (e) {
                logger.warn(`Failed to ensure parent directory ${parent}: ${(e as Error).message}`);
            }

            // Overwrite unconditionally
            try {
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(options.input.content ?? '', 'utf8'));
            } catch (e) {
                logger.error(`Failed to overwrite file ${targetUri.toString()}: ${(e as Error).message}`);
                throw e;
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Overwrote ${targetUri.fsPath}`)
            ]);
        } catch (err: unknown) {
            const msg = (err instanceof Error) ? err.message : String(err);
            Logger.getInstance().error(`OverwriteFileTool error: ${msg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error overwriting file: ${msg}`)
            ]);
        }
    }
}
