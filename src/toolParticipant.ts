import { renderPrompt } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { ToolCallRound, ToolResultMetadata, ToolUserPrompt } from './prompt';

export interface TsxToolUserMetadata {
    toolCallsMetadata: ToolCallsMetadata;
}

export interface ToolCallsMetadata {
    toolCallRounds: ToolCallRound[];
    toolCallResults: Record<string, vscode.LanguageModelToolResult>;
}

interface ReadFileToolInput {
    paths: string[];
}

export function isTsxToolUserMetadata(obj: unknown): obj is TsxToolUserMetadata {
    return !!obj &&
        !!(obj as TsxToolUserMetadata).toolCallsMetadata &&
        Array.isArray((obj as TsxToolUserMetadata).toolCallsMetadata.toolCallRounds);
}

// Helper to produce a friendly display name for the selected chat model
function getModelDisplayName(model: vscode.LanguageModelChat | undefined): string {
    if (!model) return 'unknown';
    // Prefer any readable properties if present
    // Some API versions expose `displayName` or `name`; fall back to vendor/family or id
    const anyModel: any = model as any;
    if (typeof anyModel.displayName === 'string' && anyModel.displayName.trim()) return anyModel.displayName;
    if (typeof anyModel.name === 'string' && anyModel.name.trim()) return anyModel.name;
    const vendor = anyModel.vendor ?? '';
    const family = anyModel.family ?? '';
    if (vendor || family) return `${vendor}${vendor && family ? '/' : ''}${family}`;
    return anyModel.id ?? 'unknown';
}

export function registerToolUserChatParticipant(context: vscode.ExtensionContext) {
    // We'll create the chat participant below but declare it here so the handler
    // can update the participant's name at runtime based on the selected model.
    let toolUser: vscode.ChatParticipant | undefined;


    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
        // Prefer a model the user has already selected on the chat/request/context if present.
        // There isn't a single guaranteed property name across vscode API versions, so try a few
        // likely locations using `any` and fall back to prompting the user as before.
        let model: vscode.LanguageModelChat | undefined;

        // If the request already contains a typed model, prefer it immediately.
        if ((request as any)?.model) {
            model = (request as any).model as vscode.LanguageModelChat;
        }

        // Use any typed model provided on the request or chatContext directly. Avoid complex
        // resolution fallbacks which may cause unexpected behavior; the request's model field
        // should be authoritative.
        const reqAny = request as any;
        const ctxAny = chatContext as any;
        if (!model && (ctxAny?.model)) {
            model = ctxAny.model as vscode.LanguageModelChat;
        }




        if (!model) {
            // Nothing we can do without a model; inform the user and stop handling this request.
            stream.markdown("No language model available.");
            return;
        }

        // Announce the model being used to the chat so the user sees it before the assistant PLAN
        try {
            const modelDisplay = getModelDisplayName(model);
            stream.markdown(`model: ${modelDisplay}\n\n`);
        } catch (e) {
            // Fail silently; announcing the model is optional and should not block handling
            /* noop */
        }






        const options: vscode.LanguageModelChatRequestOptions = {
            justification: 'To make a request to Cogent',
        };

        const result = await renderPrompt(
            ToolUserPrompt,
            {
                context: chatContext,
                request,
                toolCallRounds: [],
                toolCallResults: {},
                processedPrompt: request.prompt
            },
            { modelMaxPromptTokens: model.maxInputTokens },
            model
        );

        let messages = result.messages;
        result.references.forEach(ref => {
            if (ref.anchor instanceof vscode.Uri || ref.anchor instanceof vscode.Location) {
                stream.reference(ref.anchor);
            }
        });

        const toolReferences = [...request.toolReferences];
        const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
        const toolCallRounds: ToolCallRound[] = [];

        // --- Sanitization helpers to guarantee no raw code/JSON leaks to chat UI ---
        const codeSuppressionState = { suppressedOnce: false };
        const looksLikeCodeOrJson = (text: string): boolean => {
            if (!text) return false;
            if (text.includes('```')) return true; // fenced block
            // Heuristics: common TS/JS keywords or JSON file operation patterns
            const codeRegex = /(\bimport\b|\bexport\b|\bclass\b|\binterface\b|\bfunction\b|=>|const\s+\w+\s*=|"path"\s*:|"files"\s*:|"content"\s*:\s*"|<\/?[A-Za-z][A-Za-z0-9]*>)/;
            // Long braces with many colons (likely JSON or object literal)
            const manyColons = (text.match(/:/g) || []).length >= 3 && /[\{\[]/.test(text);
            return codeRegex.test(text) || manyColons;
        };
        const sanitizeForStreaming = (original: string): string => {
            if (!looksLikeCodeOrJson(original)) {
                return original;
            }
            if (!codeSuppressionState.suppressedOnce) {
                codeSuppressionState.suppressedOnce = true;
                return '⚠️ 生成されたコード/JSONはポリシーにより非表示化されました。ファイル操作は対応ツール (cogent_createFile / cogent_removeFile 等) を用いて適用します。';
            }
            // Subsequent chunks of the same hidden block are silently discarded
            return '';
        };

        const runWithTools = async (): Promise<void> => {
            const requestedTool = toolReferences.shift();
            if (requestedTool) {
                // A specific tool was requested by the chat request.
                // Only mark the toolMode as Required when we resolved exactly one matching tool.
                const matchingTools = vscode.lm.tools.filter(tool => tool.name === requestedTool.name);
                options.tools = matchingTools;
                if (matchingTools.length === 1) {
                    options.toolMode = vscode.LanguageModelChatToolMode.Required;
                } else {
                    // If multiple (or zero) tools match, don't use Required as that is not supported.
                    options.toolMode = vscode.LanguageModelChatToolMode.Auto;
                }
            } else {
                // Prefer built-in Copilot tools over custom tools
                const builtInTools = vscode.lm.tools.filter(tool => !tool.name.startsWith('cogent_'));
                const customTools = vscode.lm.tools.filter(tool => tool.name.startsWith('cogent_'));
                options.tools = [...builtInTools, ...customTools]; // Built-in first
                // When we supply many tools, Required mode is not supported — ensure Auto is set.
                options.toolMode = vscode.LanguageModelChatToolMode.Auto;
            }

            const response = await model.sendRequest(messages, options, token);
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let responseStr = '';

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    const safe = sanitizeForStreaming(part.value);
                    if (safe) {
                        stream.markdown(safe);
                        responseStr += safe;
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            if (toolCalls.length) {
                toolCallRounds.push({
                    response: responseStr,
                    toolCalls
                });

                const result = await renderPrompt(
                    ToolUserPrompt,
                    {
                        context: chatContext,
                        request,
                        toolCallRounds,
                        toolCallResults: accumulatedToolResults,
                        processedPrompt: request.prompt
                    },
                    { modelMaxPromptTokens: model.maxInputTokens },
                    model
                );

                messages = result.messages;
                const toolResultMetadata = result.metadatas.getAll(ToolResultMetadata);
                if (toolResultMetadata?.length) {
                    toolResultMetadata.forEach(meta => accumulatedToolResults[meta.toolCallId] = meta.result);
                }

                return runWithTools();
            }
        };

        await runWithTools();


        return {
            metadata: {
                toolCallsMetadata: {
                    toolCallResults: accumulatedToolResults,
                    toolCallRounds
                }
            } satisfies TsxToolUserMetadata,
        };
    };

    toolUser = vscode.chat.createChatParticipant('cogent.assistant', handler);
    toolUser.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets/cogent.jpeg');


    context.subscriptions.push(toolUser);
}
