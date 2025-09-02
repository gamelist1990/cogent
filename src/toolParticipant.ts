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

        const candidateFromRequest = (request as any)?.model || (request as any)?.selectedModel || (request as any)?.selectedChatModel;
        const candidateFromContext = (chatContext as any)?.selectedModel || (chatContext as any)?.model;

        if (candidateFromRequest) {
            model = candidateFromRequest as vscode.LanguageModelChat;
        } else if (candidateFromContext) {
            model = candidateFromContext as vscode.LanguageModelChat;
        } else {
            const MODEL_SELECTOR: vscode.LanguageModelChatSelector = { vendor: 'copilot', family: 'gpt-4.1' };
            let models = await vscode.lm.selectChatModels(MODEL_SELECTOR);
            model = models[0];
            if (!model) {
                models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
                model = models[0];
            }
        }




        if (!model) {
            // Nothing we can do without a model; inform the user and stop handling this request.
            stream.markdown("No language model available.");
            return;
        }

        // Announce the model being used to the chat so the user sees it before the assistant PLAN
        try {
            const modelDisplay = getModelDisplayName(model);
            stream.markdown(`model: ${modelDisplay}`);
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

        const runWithTools = async (): Promise<void> => {
            const requestedTool = toolReferences.shift();
            if (requestedTool) {
                // A specific tool was requested by the chat request; require that single tool.
                options.toolMode = vscode.LanguageModelChatToolMode.Required;
                options.tools = vscode.lm.tools.filter(tool => tool.name === requestedTool.name);
            }

            const response = await model.sendRequest(messages, options, token);
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let responseStr = '';

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    responseStr += part.value;
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
