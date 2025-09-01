import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../components/Logger';

interface ICreateParams {
    path: string;
    content?: string;
    overwrite?: boolean;
}

export class CreateFileTool implements vscode.LanguageModelTool<ICreateParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICreateParams>,
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

            logger.debug(`CreateFileTool: resolved targetUri=${targetUri.toString()}`);

            // Check existence
            let exists = false;
            try {
                await vscode.workspace.fs.stat(targetUri);
                exists = true;
            } catch (_) {
                exists = false;
            }

            if (exists && !options.input.overwrite) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Path already exists: ${targetUri.fsPath}`)
                ]);
            }

            // Ensure parent directory exists
            const parent = path.dirname(targetUri.fsPath);
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
            } catch (e) {
                logger.warn(`Failed to ensure parent directory ${parent}: ${(e as Error).message}`);
            }

            const content = options.input.content ?? '';
            try {
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
            } catch (e) {
                logger.error(`Failed to write file ${targetUri.toString()}: ${(e as Error).message}`);
                throw e;
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Wrote ${targetUri.fsPath}`)
            ]);
        } catch (err: unknown) {
            const msg = (err instanceof Error) ? err.message : String(err);
            Logger.getInstance().error(`CreateFileTool error: ${msg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error creating file: ${msg}`)
            ]);
        }
    }
}
