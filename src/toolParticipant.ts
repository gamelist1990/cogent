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

        // Try a variety of locations and property names that can contain the user's selected model.
        // Some API versions expose the full model object; others expose only an id / name string.
        const reqAny = request as any;
        const ctxAny = chatContext as any;

        let candidateFromRequest = reqAny?.model || reqAny?.selectedModel || reqAny?.selectedChatModel || reqAny?.modelId || reqAny?.selectedModelId || reqAny?.chatModel || reqAny?.chatModelId;
        let candidateFromContext = ctxAny?.selectedModel || ctxAny?.model || ctxAny?.selectedModelId || ctxAny?.modelId;

        // If we have a string id (e.g. 'gpt5-mini'), try to resolve it to a LanguageModelChat from available chat models.
        const resolveModel = async (cand: any): Promise<vscode.LanguageModelChat | undefined> => {
            if (!cand) return undefined;
            if (typeof cand === 'object') return cand as vscode.LanguageModelChat;
            if (typeof cand === 'string') {
                try {
                    // prefer exact id matches among available chat models
                    const all = await vscode.lm.selectChatModels({});
                    const found = all.find(m => {
                        const anyM: any = m as any;
                        return anyM.id === cand || anyM.name === cand || anyM.displayName === cand;
                    });
                    if (found) return found;
                } catch {
                    // ignore resolution failure and fall through to selector fallback
                }
            }
            return undefined;
        };

        model = await resolveModel(candidateFromRequest) ?? await resolveModel(candidateFromContext);

        if (!model) {
            // If no explicit model was found, fall back to preferred selectors but try to avoid hardcoding old family names.
            // Try to pick a modern default (prefer copilot vendor and look for a high-capability model first).
            let models: vscode.LanguageModelChat[] = [];
            try {
                models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            } catch {
                // ignore
            }

            // Prefer an explicitly high-capability family if present, otherwise pick the first returned model.
            model = models.find(m => { const a: any = m as any; return a.family && /gpt-?5|gpt5|gpt-?4\.1|gpt4\.1|gpt-?4o|4o/i.test(`${a.family}`); }) ?? models[0];

            // As a last resort, keep the older selector fallback that existed previously.
            if (!model) {
                try {
                    const MODEL_SELECTOR: vscode.LanguageModelChatSelector = { vendor: 'copilot', family: 'gpt-4.1' };
                    models = await vscode.lm.selectChatModels(MODEL_SELECTOR);
                    model = models[0];
                } catch {
                    try {
                        models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
                        model = models[0];
                    } catch {
                        // give up; model will remain undefined and be handled below
                    }
                }
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
