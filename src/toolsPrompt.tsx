import {
    AssistantMessage,
    BasePromptElementProps,
    Chunk,
    PrioritizedList,
    PromptElement,
    PromptElementProps,
    PromptMetadata,
    PromptPiece,
    PromptReference,
    PromptSizing,
    ToolCall,
    ToolMessage,
    UserMessage
} from '@vscode/prompt-tsx';
import { ToolResult } from '@vscode/prompt-tsx/dist/base/promptElements';
import * as vscode from 'vscode';
import { isTsxToolUserMetadata } from './toolParticipant';
import { listImportantFiles } from './components/listFiles';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './components/Logger';
import { buildPrompt } from './prompt';

export interface ToolCallRound {
    response: string;
    toolCalls: vscode.LanguageModelToolCallPart[];
}

export interface ToolUserProps extends BasePromptElementProps {
    request: vscode.ChatRequest;
    context: vscode.ChatContext;
    toolCallRounds: ToolCallRound[];
    toolCallResults: Record<string, vscode.LanguageModelToolResult>;
    processedPrompt?: string;
}

export class ToolUserPrompt extends PromptElement<ToolUserProps, void> {
    private async getCustomInstructions(): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return '';
        }

        try {
            const rulesPath = path.join(workspaceFolder.uri.fsPath, '.cogentrules');
            const content = await fs.readFile(rulesPath, 'utf-8');
            return content.trim();
        } catch (error) {
            // File doesn't exist or can't be read, return empty string
            return '';
        }
    }

    private getProjectStructure() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { structure: 'No workspace folder found', contents: {} };
        }
        return listImportantFiles(workspaceFolder.uri.fsPath);
    }

    private getOSLevel(): string {
        return process.platform === 'win32' 
            ? 'Windows' 
            : process.platform === 'darwin' 
                ? 'macOS' 
                : 'Linux';
    }

    private getShellType(): string {
        return process.platform === 'win32' 
            ? 'PowerShell' 
            : process.platform === 'darwin'
                ? 'zsh'
                : 'bash';
    }

    private addLineNumbers(content: string, startLine: number = 1): string {
        const lines = content.split('\n');
        const maxLineNumberWidth = String(startLine + lines.length - 1).length;
        return lines
            .map((line, index) => {
                const lineNumber = String(startLine + index).padStart(maxLineNumberWidth, ' ');
                return `${lineNumber} | ${line}`;
            })
            .join('\n');
    }

    async render(_state: void, _sizing: PromptSizing) {
        const logger = Logger.getInstance();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const { structure, contents } = this.getProjectStructure();
        logger.debug(`Project file structure:\n ${structure}`);
        const useFullWorkspace = vscode.workspace.getConfiguration('cogent').get('use_full_workspace', true);
        const customInstructions = await this.getCustomInstructions();
        const osLevel = this.getOSLevel();
        const shellType = this.getShellType();
        
        const fileContentsSection = useFullWorkspace
            ? Object.entries(contents)
                .map(([filePath, content]) => {
                    return `\n${'='.repeat(80)}\n📝 File: ${filePath}\n${'='.repeat(80)}\n${this.addLineNumbers(content)}`;
                })
                .join('\n')
            : '';


        const promptText = buildPrompt({
            structure,
            fileContentsSection,
            customInstructions,
            osLevel,
            shellType,
            useFullWorkspace,
            requestPrompt: this.props.processedPrompt || this.props.request.prompt
        });

        return (
            <>
                <UserMessage>{promptText}</UserMessage>
                <History context={this.props.context} priority={10} />
                <PromptReferences
                    references={this.props.request.references}
                    workspaceFolder={workspaceFolder}
                />
                <UserMessage>
                    {this.props.processedPrompt || this.props.request.prompt}
                </UserMessage>
                <ToolCalls
                    toolCallRounds={this.props.toolCallRounds}
                    toolInvocationToken={this.props.request.toolInvocationToken}
                    toolCallResults={this.props.toolCallResults} />
            </>
        );
    }
}

interface ToolCallsProps extends BasePromptElementProps {
    toolCallRounds: ToolCallRound[];
    toolCallResults: Record<string, vscode.LanguageModelToolResult>;
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

const dummyCancellationToken: vscode.CancellationToken = new vscode.CancellationTokenSource().token;

class ToolCalls extends PromptElement<ToolCallsProps, void> {
    async render(_state: void, _sizing: PromptSizing) {
        if (!this.props.toolCallRounds.length) {
            return undefined;
        }

        return <>
            {this.props.toolCallRounds.map(round => this.renderOneToolCallRound(round))}
            <UserMessage>Above is the result of calling one or more tools. The user cannot see the results, so you should explain them to the user if referencing them in your answer.</UserMessage>
        </>;
    }

    private renderOneToolCallRound(round: ToolCallRound) {
        const assistantToolCalls: ToolCall[] = round.toolCalls.map(tc => ({ 
            type: 'function', 
            function: { 
                name: tc.name, 
                arguments: JSON.stringify(tc.input) 
            }, 
            id: tc.callId 
        }));
        
        return (
            <Chunk>
                <AssistantMessage toolCalls={assistantToolCalls}>{round.response}</AssistantMessage>
                {round.toolCalls.map(toolCall =>
                    <ToolResultElement 
                        toolCall={toolCall} 
                        toolInvocationToken={this.props.toolInvocationToken} 
                        toolCallResult={this.props.toolCallResults[toolCall.callId]} 
                    />
                )}
            </Chunk>
        );
    }
}

interface ToolResultElementProps extends BasePromptElementProps {
    toolCall: vscode.LanguageModelToolCallPart;
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
    toolCallResult: vscode.LanguageModelToolResult | undefined;
}

class ToolResultElement extends PromptElement<ToolResultElementProps, void> {
    async render(state: void, sizing: PromptSizing): Promise<PromptPiece | undefined> {
        const logger = Logger.getInstance();
        const tool = vscode.lm.tools.find(t => t.name === this.props.toolCall.name);
        if (!tool) {
            logger.error(`Tool not found: ${this.props.toolCall.name}`);
            return <ToolMessage toolCallId={this.props.toolCall.callId}>Tool not found</ToolMessage>;
        }

        const tokenizationOptions: vscode.LanguageModelToolTokenizationOptions = {
            tokenBudget: sizing.tokenBudget,
            countTokens: async (content: string) => sizing.countTokens(content),
        };

        let toolResult: vscode.LanguageModelToolResult | undefined = this.props.toolCallResult;
        try {
            if (!toolResult) {
                toolResult = await vscode.lm.invokeTool(
                    this.props.toolCall.name,
                    {
                        input: this.props.toolCall.input,
                        toolInvocationToken: this.props.toolInvocationToken,
                        tokenizationOptions
                    },
                    dummyCancellationToken
                );
            }

            // Defensive: if toolResult is falsy or doesn't contain expected data, provide a safe message
            if (!toolResult) {
                return <ToolMessage toolCallId={this.props.toolCall.callId}>Tool returned no result</ToolMessage>;
            }

            // Some tool results may have missing patch text/stream for certain tool types. Wrap rendering in try/catch
            try {
                return (
                    <ToolMessage toolCallId={this.props.toolCall.callId}>
                        <meta value={new ToolResultMetadata(this.props.toolCall.callId, toolResult)}></meta>
                        <ToolResult data={toolResult} />
                    </ToolMessage>
                );
            } catch (err) {
                const msg = (err instanceof Error) ? err.message : String(err);
                Logger.getInstance().error(`Failed to render tool result for ${this.props.toolCall.name}: ${msg}`);
                return <ToolMessage toolCallId={this.props.toolCall.callId}>Unable to render tool result: {msg}</ToolMessage>;
            }
        } catch (invokeErr) {
            const msg = (invokeErr instanceof Error) ? invokeErr.message : String(invokeErr);
            Logger.getInstance().error(`Tool invocation failed for ${this.props.toolCall.name}: ${msg}`);
            return <ToolMessage toolCallId={this.props.toolCall.callId}>Tool invocation failed: {msg}</ToolMessage>;
        }
    }
}

export class ToolResultMetadata extends PromptMetadata {
    constructor(
        public toolCallId: string,
        public result: vscode.LanguageModelToolResult,
    ) {
        super();
    }
}

interface HistoryProps extends BasePromptElementProps {
    priority: number;
    context: vscode.ChatContext;
}

class History extends PromptElement<HistoryProps, void> {
    render(_state: void, _sizing: PromptSizing) {
        return (
            <PrioritizedList priority={this.props.priority} descending={false}>
                {this.props.context.history.map((message) => {
                    if (message instanceof vscode.ChatRequestTurn) {
                        return (
                            <>
                                <PromptReferences 
                                    references={message.references} 
                                    excludeReferences={true} 
                                />
                                <UserMessage>{message.prompt}</UserMessage>
                            </>
                        );
                    } else if (message instanceof vscode.ChatResponseTurn) {
                        const metadata = message.result.metadata;
                        if (isTsxToolUserMetadata(metadata) && metadata.toolCallsMetadata.toolCallRounds.length > 0) {
                            return <ToolCalls 
                                toolCallResults={metadata.toolCallsMetadata.toolCallResults} 
                                toolCallRounds={metadata.toolCallsMetadata.toolCallRounds} 
                                toolInvocationToken={undefined} 
                            />;
                        }
                        return <AssistantMessage>{chatResponseToString(message)}</AssistantMessage>;
                    }
                })}
            </PrioritizedList>
        );
    }
}

function chatResponseToString(response: vscode.ChatResponseTurn): string {
    return response.response
        .map((r) => {
            if (r instanceof vscode.ChatResponseMarkdownPart) {
                return r.value.value;
            } else if (r instanceof vscode.ChatResponseAnchorPart) {
                if (r.value instanceof vscode.Uri) {
                    return r.value.fsPath;
                } else {
                    return r.value.uri.fsPath;
                }
            }
            return '';
        })
        .join('');
}

interface PromptReferencesProps extends BasePromptElementProps {
    references: ReadonlyArray<vscode.ChatPromptReference>;
    excludeReferences?: boolean;
    workspaceFolder?: vscode.WorkspaceFolder;
}

class PromptReferences extends PromptElement<PromptReferencesProps, void> {
    render(_state: void, _sizing: PromptSizing): PromptPiece {
        return (
            <UserMessage>
                {this.props.references.map(ref => (
                    <PromptReferenceElement 
                        ref={ref} 
                        excludeReferences={this.props.excludeReferences}
                        workspaceFolder={this.props.workspaceFolder}
                    />
                ))}
            </UserMessage>
        );
    }
}

interface PromptReferenceProps extends BasePromptElementProps {
    ref: vscode.ChatPromptReference;
    excludeReferences?: boolean;
    workspaceFolder?: vscode.WorkspaceFolder;
}

class PromptReferenceElement extends PromptElement<PromptReferenceProps> {
    async render(_state: void, _sizing: PromptSizing): Promise<PromptPiece | undefined> {
        const value = this.props.ref.value;
        if (value instanceof vscode.Uri) {
            let uri = value;
            // If the Uri has no scheme and looks like an absolute path (starts with drive or /),
            // don't join it to the workspace folder. Only treat it as workspace-relative when it's a relative path.
            if (!uri.scheme && this.props.workspaceFolder) {
                const raw = uri.fsPath || '';
                const isWindowsDrive = /^[a-zA-Z]:\\/.test(raw) || /^[a-zA-Z]:\//.test(raw);
                const isAbsolutePath = path.isAbsolute(raw) || isWindowsDrive;
                if (!isAbsolutePath) {
                    uri = vscode.Uri.file(path.join(this.props.workspaceFolder.uri.fsPath, uri.fsPath));
                } else {
                    uri = vscode.Uri.file(path.normalize(raw));
                }
            }
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                // If the URI is a directory, avoid readFile which throws EISDIR.
                if (stat.type === vscode.FileType.Directory) {
                    const entries = await vscode.workspace.fs.readDirectory(uri);
                    const names = entries
                        .map(([name, type]) => `${name}${type === vscode.FileType.Directory ? '/' : ''}`)
                        .join(', ');
                    return (
                        <Tag name="context">
                            {!this.props.excludeReferences && 
                                <references value={[new PromptReference(uri)]} />}
                            {uri.fsPath}:<br />
                            ``` <br />
                            Directory contents: {names}<br />
                            ```<br />
                        </Tag>
                    );
                }

                const fileContents = (await vscode.workspace.fs.readFile(uri)).toString();
                return (
                    <Tag name="context">
                        {!this.props.excludeReferences && 
                            <references value={[new PromptReference(uri)]} />}
                        {uri.fsPath}:<br />
                        ``` <br />
                        {fileContents}<br />
                        ```<br />
                    </Tag>
                );
            } catch (err) {
                // If anything goes wrong (permissions, EISDIR, etc.), show a safe message.
                const msg = (err instanceof Error) ? err.message : String(err);
                return (
                    <Tag name="context">
                        {!this.props.excludeReferences && 
                            <references value={[new PromptReference(uri)]} />}
                        {uri.fsPath}:<br />
                        ``` <br />
                        Unable to read resource: {msg}<br />
                        ```<br />
                    </Tag>
                );
            }
        } else if (value instanceof vscode.Location) {
            let uri = value.uri;
            if (!uri.scheme && this.props.workspaceFolder) {
                const raw = uri.fsPath || '';
                const isWindowsDrive = /^[a-zA-Z]:\\/.test(raw) || /^[a-zA-Z]:\//.test(raw);
                const isAbsolutePath = path.isAbsolute(raw) || isWindowsDrive;
                if (!isAbsolutePath) {
                    uri = vscode.Uri.file(path.join(this.props.workspaceFolder.uri.fsPath, uri.fsPath));
                } else {
                    uri = vscode.Uri.file(path.normalize(raw));
                }
            }
            const rangeText = (await vscode.workspace.openTextDocument(uri))
                .getText(value.range);
            return (
                <Tag name="context">
                    {!this.props.excludeReferences && 
                        <references value={[new PromptReference(value)]} />}
                    {uri.fsPath}:{value.range.start.line + 1}-
                    {value.range.end.line + 1}: <br />
                    ```<br />
                    {rangeText}<br />
                    ```
                </Tag>
            );
        } else if (typeof value === 'string') {
            return <Tag name="context">{value}</Tag>;
        }
    }
}

type TagProps = PromptElementProps<{
    name: string;
}>;

class Tag extends PromptElement<TagProps> {
    private static readonly _regex = /^[a-zA-Z_][\w.-]*$/;

    render() {
        const { name } = this.props;
        if (!Tag._regex.test(name)) {
            throw new Error(`Invalid tag name: ${this.props.name}`);
        }
        return (
            <>
                {'<' + name + '>'}<br />
                <>{this.props.children}<br /></>
                {'</' + name + '>'}<br />
            </>
        );
    }
}
