import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { preInvokeHint, postSuccessHint, postErrorHint } from './AgentToolHelpers';

interface IDiffUpdateParams {
    path: string;
    search: string;
    replace: string;
    context?: number; // 前後のコンテキスト行数（デフォルト: 3）
    validateOnly?: boolean; // 検証のみ実行（実際の更新は行わない）
}

export class DiffUpdateTool implements vscode.LanguageModelTool<IDiffUpdateParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDiffUpdateParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const rawPath = (options.input.path ?? '').toString().trim();
            if (!rawPath) {
                throw new Error('Path is required (provide a path relative to the workspace root)');
            }

            // パスの正規化
            let normalizedRawPath = rawPath;
            if (normalizedRawPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(normalizedRawPath)) {
                normalizedRawPath = normalizedRawPath.replace(/^\/+/, '');
            }

            const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(normalizedRawPath);
            const isAbsolutePath = path.isAbsolute(normalizedRawPath) || isWindowsDrive;

            let targetFsPath: string;
            if (isAbsolutePath) {
                targetFsPath = path.normalize(normalizedRawPath);
            } else {
                targetFsPath = path.normalize(path.resolve(workspaceFolder.uri.fsPath, normalizedRawPath));
            }

            // Determine whether the target is inside the workspace
            const relative = path.relative(workspaceFolder.uri.fsPath, targetFsPath);
            const outsideWorkspace = relative.startsWith('..') || path.isAbsolute(targetFsPath) && !relative && path.normalize(targetFsPath) !== path.normalize(path.resolve(workspaceFolder.uri.fsPath));

            const allowExternal = vscode.workspace.getConfiguration('cogent').get('allowExternalFileEdit', false);

            // If outside workspace and not allowed, refuse
            if (outsideWorkspace && !allowExternal) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(preInvokeHint('DiffUpdateTool', options.input.path)),
                    new vscode.LanguageModelTextPart(postErrorHint('DiffUpdateTool', `Refusing to read/update files outside the workspace root. To allow this, enable 'cogent.allowExternalFileEdit' in settings.`))
                ]);
            }

            const targetUri = vscode.Uri.file(targetFsPath);

            // ファイルの存在確認 / 読み取り
            let fileExists = true;
            let currentContent = '';
            try {
                if (outsideWorkspace) {
                    // Use node fs for external files
                    await fsp.stat(targetFsPath);
                    const buf = await fsp.readFile(targetFsPath);
                    currentContent = buf.toString('utf8');
                } else {
                    await vscode.workspace.fs.stat(targetUri);
                    const fileContent = await vscode.workspace.fs.readFile(targetUri);
                    currentContent = Buffer.from(fileContent).toString('utf8');
                }
            } catch (err) {
                fileExists = false;
            }

            if (!fileExists) {
                throw new Error(`File ${options.input.path} does not exist`);
            }

            // 検索文字列のバリデーション
            const searchText = options.input.search;
            const replaceText = options.input.replace;
            
            if (!searchText) {
                throw new Error('Search text is required');
            }

            if (replaceText === undefined) {
                throw new Error('Replace text is required (use empty string for deletion)');
            }

            // 検索文字列の位置を特定
            const searchIndex = currentContent.indexOf(searchText);
            if (searchIndex === -1) {
                throw new Error(`Search text not found in file ${options.input.path}`);
            }

            // 複数の一致がある場合の警告
            const allMatches = this.findAllMatches(currentContent, searchText);
            if (allMatches.length > 1) {
                const contextLines = options.input.context ?? 3;
                const matchDetails = allMatches.map((match, index) => {
                    const context = this.getContextAroundMatch(currentContent, match, contextLines);
                    return `Match ${index + 1} (line ${context.lineNumber}):\n${context.contextText}`;
                }).join('\n\n');

                throw new Error(`Multiple matches found for search text. Please be more specific.\n\n${matchDetails}`);
            }

            // 検証のみの場合
            if (options.input.validateOnly) {
                const contextLines = options.input.context ?? 3;
                const context = this.getContextAroundMatch(currentContent, searchIndex, contextLines);
                
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(preInvokeHint('DiffUpdateTool', options.input.path)),
                    new vscode.LanguageModelTextPart(`Validation successful: Found search text at line ${context.lineNumber}`),
                    new vscode.LanguageModelTextPart(`Context:\n${context.contextText}`),
                    new vscode.LanguageModelTextPart(postSuccessHint('DiffUpdateTool'))
                ]);
            }

            // 差分を適用
            const updatedContent = currentContent.substring(0, searchIndex) + replaceText + currentContent.substring(searchIndex + searchText.length);

            // ファイルを更新
            const updatedBuffer = Buffer.from(updatedContent, 'utf8');
            if (outsideWorkspace) {
                // Write using node fs for external files
                await fsp.writeFile(targetFsPath, updatedBuffer);
            } else {
                await vscode.workspace.fs.writeFile(targetUri, updatedBuffer);
            }

            // コンテキスト情報を取得
            const contextLines = options.input.context ?? 3;
            const beforeContext = this.getContextAroundMatch(currentContent, searchIndex, contextLines);
            const afterContext = this.getContextAroundMatch(updatedContent, searchIndex, contextLines);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('DiffUpdateTool', options.input.path)),
                new vscode.LanguageModelTextPart(`Successfully updated file ${options.input.path}`),
                new vscode.LanguageModelTextPart(`Applied diff at line ${beforeContext.lineNumber}`),
                new vscode.LanguageModelTextPart(`\nBefore:\n${beforeContext.contextText}`),
                new vscode.LanguageModelTextPart(`\nAfter:\n${afterContext.contextText}`),
                new vscode.LanguageModelTextPart(postSuccessHint('DiffUpdateTool'))
            ]);

        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(preInvokeHint('DiffUpdateTool', options.input.path)),
                new vscode.LanguageModelTextPart(postErrorHint('DiffUpdateTool', (err as Error)?.message))
            ]);
        }
    }

    private findAllMatches(content: string, searchText: string): number[] {
        const matches: number[] = [];
        let index = content.indexOf(searchText);
        while (index !== -1) {
            matches.push(index);
            index = content.indexOf(searchText, index + 1);
        }
        return matches;
    }

    private getContextAroundMatch(content: string, matchIndex: number, contextLines: number): { lineNumber: number; contextText: string } {
        const lines = content.split('\n');
        let currentIndex = 0;
        let lineNumber = 0;

        // 一致した位置の行番号を特定
        for (let i = 0; i < lines.length; i++) {
            if (currentIndex + lines[i].length >= matchIndex) {
                lineNumber = i + 1; // 1-based line number
                break;
            }
            currentIndex += lines[i].length + 1; // +1 for newline
        }

        // コンテキスト行を取得
        const startLine = Math.max(0, lineNumber - 1 - contextLines);
        const endLine = Math.min(lines.length, lineNumber + contextLines);
        const contextLines_array = lines.slice(startLine, endLine);

        // 行番号付きでフォーマット
        const contextText = contextLines_array
            .map((line, index) => {
                const actualLineNumber = startLine + index + 1;
                const marker = actualLineNumber === lineNumber ? '>' : ' ';
                return `${marker} ${actualLineNumber.toString().padStart(3, ' ')}: ${line}`;
            })
            .join('\n');

        return { lineNumber, contextText };
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDiffUpdateParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.diffUpdate', false);
        const action = options.input.validateOnly ? 'Validate diff' : 'Apply diff';
        const message = `${action} to ${options.input.path}`;
        
        if (autoConfirm) return { invocationMessage: message };

        const searchPreview = options.input.search.length > 50 
            ? options.input.search.substring(0, 50) + '...' 
            : options.input.search;
        
        const replacePreview = options.input.replace.length > 50 
            ? options.input.replace.substring(0, 50) + '...' 
            : options.input.replace;

        return {
            invocationMessage: message,
            confirmationMessages: {
                title: 'Diff Update',
                message: new vscode.MarkdownString(
                    `${message}?\n\n**Search:** \`${searchPreview}\`\n**Replace:** \`${replacePreview}\``
                )
            }
        };
    }
}
