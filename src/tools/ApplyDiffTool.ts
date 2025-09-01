import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { DiffView } from '../components/DiffView';
import { UnsavedChangesDetector } from '../components/UnsavedChangesDetector';
import { Logger } from '../components/Logger';

// Types
type DiffResult = 
  | { success: true; content: string }
  | { success: false; error: string; details?: { 
      similarity?: number;
      threshold?: number;
      matchedRange?: { start: number; end: number };
      searchContent?: string;
      bestMatch?: string;
    }};

// Helper functions
function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= a.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            if (a[i-1] === b[j-1]) {
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i-1][j-1] + 1,
                    matrix[i][j-1] + 1,
                    matrix[i-1][j] + 1
                );
            }
        }
    }

    return matrix[a.length][b.length];
}

function getSimilarity(original: string, search: string): number {
    if (search === '') return 1;

    const normalizeStr = (str: string) => str.replace(/\s+/g, ' ').trim();
    const normalizedOriginal = normalizeStr(original);
    const normalizedSearch = normalizeStr(search);
    
    if (normalizedOriginal === normalizedSearch) return 1;
    
    const distance = levenshteinDistance(normalizedOriginal, normalizedSearch);
    const maxLength = Math.max(normalizedOriginal.length, normalizedSearch.length);
    return 1 - (distance / maxLength);
}

function addLineNumbers(content: string, startLine: number = 1): string {
    const lines = content.split('\n');
    const maxLineNumberWidth = String(startLine + lines.length - 1).length;
    return lines
        .map((line, index) => {
            const lineNumber = String(startLine + index).padStart(maxLineNumberWidth, ' ');
            return `${lineNumber} | ${line}`;
        })
        .join('\n');
}

function everyLineHasLineNumbers(content: string): boolean {
    const lines = content.split(/\r?\n/);
    return lines.length > 0 && lines.every(line => /^\s*\d+\s+\|(?!\|)/.test(line));
}

function stripLineNumbers(content: string): string {
    const lines = content.split(/\r?\n/);
    const processedLines = lines.map(line => {
        const match = line.match(/^\s*\d+\s+\|(?!\|)\s?(.*)$/);
        return match ? match[1] : line;
    });
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    return processedLines.join(lineEnding);
}

class SearchReplaceDiffStrategy {
    private fuzzyThreshold: number;
    private bufferLines: number;
    private readonly BUFFER_LINES = 20;

    constructor(fuzzyThreshold?: number, bufferLines?: number) {
        this.fuzzyThreshold = fuzzyThreshold ?? 1.0;
        this.bufferLines = bufferLines ?? this.BUFFER_LINES;
    }

    applyDiff(originalContent: string, diffContent: string, startLine?: number, endLine?: number): DiffResult {
        const match = diffContent.match(/<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/);
        if (!match) {
            return {
                success: false,
                error: 'Invalid diff format - missing required SEARCH/REPLACE sections'
            };
        }

        let [_, searchContent, replaceContent] = match;
        const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';

        if (everyLineHasLineNumbers(searchContent) && everyLineHasLineNumbers(replaceContent)) {
            searchContent = stripLineNumbers(searchContent);
            replaceContent = stripLineNumbers(replaceContent);
        }

        const searchLines = searchContent === '' ? [] : searchContent.split(/\r?\n/);
        const replaceLines = replaceContent === '' ? [] : replaceContent.split(/\r?\n/);
        const originalLines = originalContent.split(/\r?\n/);

        if (searchLines.length === 0 && !startLine) {
            return {
                success: false,
                error: 'Empty search content requires start_line to be specified'
            };
        }

        if (searchLines.length === 0 && startLine && endLine && startLine !== endLine) {
            return {
                success: false,
                error: `Empty search content requires start_line and end_line to be the same (got ${startLine}-${endLine})`
            };
        }

        let matchIndex = -1;
        let bestMatchScore = 0;
        let bestMatchContent = "";
        const searchChunk = searchLines.join('\n');

        let searchStartIndex = 0;
        let searchEndIndex = originalLines.length;

        if (startLine && endLine) {
            const exactStartIndex = startLine - 1;
            const exactEndIndex = endLine - 1;

            if (exactStartIndex < 0 || exactEndIndex >= originalLines.length || exactStartIndex > exactEndIndex) {
                return {
                    success: false,
                    error: `Line range ${startLine}-${endLine} is invalid (file has ${originalLines.length} lines)`
                };
            }

            const originalChunk = originalLines.slice(exactStartIndex, exactEndIndex + 1).join('\n');
            const similarity = getSimilarity(originalChunk, searchChunk);
            
            if (similarity >= this.fuzzyThreshold) {
                matchIndex = exactStartIndex;
                bestMatchScore = similarity;
                bestMatchContent = originalChunk;
            } else {
                searchStartIndex = Math.max(0, startLine - (this.bufferLines + 1));
                searchEndIndex = Math.min(originalLines.length, endLine + this.bufferLines);
            }
        }

        // Middle-out search if no exact match found
        if (matchIndex === -1) {
            const midPoint = Math.floor((searchStartIndex + searchEndIndex) / 2);
            let leftIndex = midPoint;
            let rightIndex = midPoint + 1;

            while (leftIndex >= searchStartIndex || rightIndex <= searchEndIndex - searchLines.length) {
                if (leftIndex >= searchStartIndex) {
                    const chunk = originalLines.slice(leftIndex, leftIndex + searchLines.length).join('\n');
                    const similarity = getSimilarity(chunk, searchChunk);
                    if (similarity > bestMatchScore) {
                        bestMatchScore = similarity;
                        matchIndex = leftIndex;
                        bestMatchContent = chunk;
                    }
                    leftIndex--;
                }

                if (rightIndex <= searchEndIndex - searchLines.length) {
                    const chunk = originalLines.slice(rightIndex, rightIndex + searchLines.length).join('\n');
                    const similarity = getSimilarity(chunk, searchChunk);
                    if (similarity > bestMatchScore) {
                        bestMatchScore = similarity;
                        matchIndex = rightIndex;
                        bestMatchContent = chunk;
                    }
                    rightIndex++;
                }
            }
        }

        if (matchIndex === -1 || bestMatchScore < this.fuzzyThreshold) {
            const searchChunk = searchLines.join('\n');
            const originalContentSection = startLine !== undefined && endLine !== undefined
                ? `\n\nOriginal Content:\n${addLineNumbers(
                    originalLines.slice(
                        Math.max(0, startLine - 1 - this.bufferLines),
                        Math.min(originalLines.length, endLine + this.bufferLines)
                    ).join('\n'),
                    Math.max(1, startLine - this.bufferLines)
                )}`
                : `\n\nOriginal Content:\n${addLineNumbers(originalLines.join('\n'))}`;

            const bestMatchSection = bestMatchContent
                ? `\n\nBest Match Found:\n${addLineNumbers(bestMatchContent, matchIndex + 1)}`
                : `\n\nBest Match Found:\n(no match)`;

            const lineRange = startLine || endLine ?
                ` at ${startLine ? `start: ${startLine}` : 'start'} to ${endLine ? `end: ${endLine}` : 'end'}` : '';
                
            return {
                success: false,
                error: `No sufficiently similar match found${lineRange} (${Math.floor(bestMatchScore * 100)}% similar, needs ${Math.floor(this.fuzzyThreshold * 100)}%)\n\nDebug Info:\n- Similarity Score: ${Math.floor(bestMatchScore * 100)}%\n- Required Threshold: ${Math.floor(this.fuzzyThreshold * 100)}%\n- Search Range: ${startLine && endLine ? `lines ${startLine}-${endLine}` : 'start to end'}\n\nSearch Content:\n${addLineNumbers(searchChunk)}${bestMatchSection}${originalContentSection}`
            };
        }

        const matchedLines = originalLines.slice(matchIndex, matchIndex + searchLines.length);
        const originalIndents = matchedLines.map(line => {
            const match = line.match(/^[\t ]*/);
            return match ? match[0] : '';
        });

        const searchIndents = searchLines.map(line => {
            const match = line.match(/^[\t ]*/);
            return match ? match[0] : '';
        });

        const indentedReplaceLines = replaceLines.map((line, i) => {
            const matchedIndent = originalIndents[0] || '';
            const currentIndentMatch = line.match(/^[\t ]*/);
            const currentIndent = currentIndentMatch ? currentIndentMatch[0] : '';
            const searchBaseIndent = searchIndents[0] || '';
            
            const searchBaseLevel = searchBaseIndent.length;
            const currentLevel = currentIndent.length;
            const relativeLevel = currentLevel - searchBaseLevel;
            
            const finalIndent = relativeLevel < 0
                ? matchedIndent.slice(0, Math.max(0, matchedIndent.length + relativeLevel))
                : matchedIndent + currentIndent.slice(searchBaseLevel);
            
            return finalIndent + line.trim();
        });

        const beforeMatch = originalLines.slice(0, matchIndex);
        const afterMatch = originalLines.slice(matchIndex + searchLines.length);
        const finalContent = [...beforeMatch, ...indentedReplaceLines, ...afterMatch].join(lineEnding);

        return {
            success: true,
            content: finalContent
        };
    }
}

interface ApplyDiffInput {
    path: string;
    diff: string;
    start_line: number;
    end_line: number;
}

export class ApplyDiffTool implements vscode.LanguageModelTool<ApplyDiffInput> {
    private diffStrategy: SearchReplaceDiffStrategy;

    constructor() {
        this.diffStrategy = new SearchReplaceDiffStrategy();
    }

    private diffView?: DiffView;

    private addLineNumbers(content: string): string {
        const lines = content.split('\n');
        const maxLineNumberWidth = String(lines.length).length;
        return lines
            .map((line, index) => {
                const lineNumber = String(index + 1).padStart(maxLineNumberWidth, ' ');
                return `${lineNumber} | ${line}`;
            })
            .join('\n');
    }

    private async safeApplyDiff(filePath: string, newContent: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const logger = Logger.getInstance();

        try {
            // Open the document if not already open
            let document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
            if (!document) {
                document = await vscode.workspace.openTextDocument(uri);
            }

            // Backup current content
            const backupContent = document.getText();

            // Listen for changes to verify the edit
            let changeDetected = false;
            const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.toString() === uri.toString()) {
                    changeDetected = true;
                }
            });

            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
            edit.replace(uri, fullRange, newContent);

            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                logger.warn(`Failed to apply edit to ${filePath}`);
                throw new Error('Workspace edit failed');
            }

            // Wait a bit for the change to be detected
            await new Promise(resolve => setTimeout(resolve, 100));

            if (!changeDetected) {
                logger.warn(`No change detected after applying edit to ${filePath}`);
                // Restore backup
                const restoreEdit = new vscode.WorkspaceEdit();
                restoreEdit.replace(uri, fullRange, backupContent);
                await vscode.workspace.applyEdit(restoreEdit);
                throw new Error('Change not applied successfully');
            }

            // Verify the content
            const updatedDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
            if (updatedDocument && updatedDocument.getText() !== newContent) {
                logger.warn(`Content mismatch after applying edit to ${filePath}`);
                // Restore backup
                const restoreEdit = new vscode.WorkspaceEdit();
                restoreEdit.replace(uri, fullRange, backupContent);
                await vscode.workspace.applyEdit(restoreEdit);
                throw new Error('Content verification failed');
            }

            changeListener.dispose();
            logger.info(`Successfully applied diff to ${filePath}`);

        } catch (error) {
            logger.error(`Error in safeApplyDiff for ${filePath}: ${error}`);
            throw error;
        }
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ApplyDiffInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const fullPath = path.join(workspaceFolder.uri.fsPath, options.input.path);
            
            // Prevent operating on directories
            try {
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Path ${options.input.path} is a directory. Apply-diff supports files only.`)
                    ]);
                }
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error accessing path ${options.input.path}: ${(err as Error)?.message}`)
                ]);
            }

            // First check for any unsaved changes
            const unsavedChanges = await UnsavedChangesDetector.detectChanges(options.input.path);
            // Use editor content if there are unsaved changes, otherwise use disk content
            const baseContent = unsavedChanges.editorContent || await fs.readFile(fullPath, 'utf-8');

            const result = this.diffStrategy.applyDiff(
                baseContent, // Apply diff to current content, not disk content
                options.input.diff,
                options.input.start_line,
                options.input.end_line
            );

            // Before showing/applying, try to extract a candidate symbol from the diff for usage lookup
            try {
                const searchMatch = options.input.diff.match(/<<<<<<< SEARCH\n([\s\S]*?)\n?=======/);
                const searchContent = searchMatch ? searchMatch[1] : options.input.diff;
                const candidateSymbol = (function extract(content: string): string | undefined {
                    if (!content) return undefined;
                    const fn = content.match(/(?:function|def)\s+([A-Za-z_][\w]*)/);
                    if (fn) return fn[1];
                    const cl = content.match(/class\s+([A-Za-z_][\w]*)/);
                    if (cl) return cl[1];
                    const id = content.match(/\b([A-Za-z_][\w]{2,})\b/);
                    return id ? id[1] : undefined;
                })(searchContent);

                if (candidateSymbol) {
                    try {
                        const token = new vscode.CancellationTokenSource().token;
                        const res = await vscode.lm.invokeTool('cogent_getVscodeApi', { input: { action: 'list_code_usages', symbol: { name: candidateSymbol } }, toolInvocationToken: undefined }, token);
                        const anyRes: any = res;
                        const usages = (anyRes?.parts ?? []).map((p: any) => p?.text ?? p?.value ?? '').join('\n') ?? '';
                        if (usages) {
                            // Prepend usage info to response
                            const infoPart = `Detected usages for symbol '${candidateSymbol}':\n${usages}\n\n`;
                            // If result is success, attach to content response later by storing in a variable
                            // We'll include it in the response after diff view update
                            (result as any)._usageInfo = infoPart;
                        }
                    } catch {
                        // ignore
                    }
                }
            } catch {
                // ignore symbol extraction errors
            }

            if (!result.success) {
                throw new Error(result.error);
            }

            // Show diff view with current content as base
            this.diffView = new DiffView(fullPath, baseContent);
            await this.diffView.show();
            
            // Apply changes safely using VS Code API
            await this.safeApplyDiff(fullPath, result.content);

            // Get the latest content with unsaved changes
            const unsavedResult = await UnsavedChangesDetector.detectChanges(options.input.path);
            const currentContent = unsavedResult.editorContent || result.content;
            
            // Create response with current file state
            const response = [
                `Changes shown in diff view for ${options.input.path}.`,
                '',
                'Current file state:',
                '=' .repeat(80),
                this.addLineNumbers(currentContent)
            ].join('\n');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(response)
            ]);

        } catch (error) {
            if (this.diffView) {
                await this.diffView.close();
            }
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const logger = Logger.getInstance();
            logger.error(`Failed to apply diff: ${errorMessage}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Failed to apply diff: ${errorMessage}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ApplyDiffInput>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.applyDiff', false);
        
        if (autoConfirm) {
            return {
                invocationMessage: `Applying diff to ${options.input.path} (lines ${options.input.start_line}-${options.input.end_line})`
            };
        }

        return {
            invocationMessage: `Applying diff to ${options.input.path} (lines ${options.input.start_line}-${options.input.end_line})`,
            confirmationMessages: {
                title: 'Apply Diff',
                message: new vscode.MarkdownString(
                    `Apply diff to ${options.input.path} between lines ${options.input.start_line}-${options.input.end_line}?`
                )
            }
        };
    }
}


