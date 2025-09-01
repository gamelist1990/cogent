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

export function registerToolUserChatParticipant(context: vscode.ExtensionContext) {
    // We'll create the chat participant below but declare it here so the handler
    // can update the participant's name at runtime based on the selected model.
    let toolUser: vscode.ChatParticipant | undefined;

    function getModelDisplayName(model: vscode.LanguageModelChat | undefined): string {
        if (!model) return 'unknown-model';
        const anyM: any = model as any;
        return (anyM.displayName || anyM.name || anyM.id || `${anyM.vendor ?? ''}/${anyM.family ?? ''}`).toString();
    }

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

        // Check if inputTextFix is enabled
        const inputTextFix = vscode.workspace.getConfiguration('cogent').get('inputTextFix', false);
        let processedPrompt = request.prompt;
        if (inputTextFix && model) {
            try {
                // Use AI to expand concise user input to more detailed prompt
                const expandMessages: vscode.LanguageModelChatMessage[] = [
                    vscode.LanguageModelChatMessage.User(`You are a helpful assistant that understands user intent from concise inputs and expands them into detailed, clear prompts for an AI coding assistant.

Given the user's concise input, analyze their likely intent and create a more detailed, specific prompt that captures what they probably want to achieve.

Examples:
- "リンゴを食べたい" → "I want to know how to eat an apple properly, including preparation steps and any tips for enjoying it."
- "コードを書く" → "I need help writing code for a specific task. Please provide guidance on best practices and implementation steps."
- "バグを直す" → "I have a bug in my code that needs to be fixed. Please help me identify and resolve the issue."

User input: "${request.prompt}"

Please provide a detailed, expanded version of this prompt that clearly expresses the user's likely intent:`)
                ];

                const expandResponse = await model.sendRequest(expandMessages, { justification: 'Expanding user input for better understanding' }, token);
                let expandedText = '';
                for await (const part of expandResponse.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        expandedText += part.value;
                    }
                }
                if (expandedText.trim()) {
                    processedPrompt = expandedText.trim();
                }
            } catch (error) {
                // If expansion fails, fall back to original prompt
                console.warn('Failed to expand user input:', error);
            }
        }

        // Update the chat participant's displayed name to include the chosen model
        try {
            const modelLabel = getModelDisplayName(model);
            if (toolUser) {
                // Assign to .name property which corresponds to chatParticipants.name
                // Some API surfaces may accept displayName; we set name to match package.json
                (toolUser as any).name = `cogent (${modelLabel})`;
            }
        } catch (e) {
            // non-fatal; continue without changing name
        }

        if (!model) {
            // Nothing we can do without a model; inform the user and stop handling this request.
            stream.markdown("No language model available.");
            return;
        }

        const useFullWorkspace = vscode.workspace.getConfiguration('cogent').get('use_full_workspace', false);
        // New config to control whether we should always prefer using tools
        const alwaysUseTools = vscode.workspace.getConfiguration('cogent').get('alwaysUseTools', true);

        // Base set: cogent_ tools (optionally excluding readFile when useFullWorkspace=false)
        let tools = vscode.lm.tools.filter(tool =>
            typeof tool.name === 'string' &&
            tool.name.startsWith('cogent_') &&
            (!useFullWorkspace || tool.name !== 'cogent_readFile')
        );

        // Ensure the getVscodeApi tool and any Copilot-provided tools are available by default.
        // We prefer tools named 'cogent_getVscodeApi' and any tool whose name contains 'copilot' or 'getvscodeapi'.
        const extraPreferred = vscode.lm.tools.filter(t => {
            if (!t || typeof t.name !== 'string') return false;
            const n = t.name.toLowerCase();
            return n === 'cogent_getvscodeapi' || n.includes('copilot') || n.includes('getvscodeapi');
        });

        // Merge and dedupe by name
        const byName = new Map<string, typeof extraPreferred[0]>();
        for (const t of [...tools, ...extraPreferred]) {
            if (typeof t.name === 'string' && !byName.has(t.name)) byName.set(t.name, t);
        }
        tools = Array.from(byName.values());

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
                processedPrompt
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
        let hasFileUpdateCall = false;

        const runWithTools = async (): Promise<void> => {
            const requestedTool = toolReferences.shift();
            if (requestedTool) {
                options.toolMode = vscode.LanguageModelChatToolMode.Required;
                options.tools = vscode.lm.tools.filter(tool => tool.name === requestedTool.name);
            } else if (alwaysUseTools) {
                // If configured to always use tools, make them Required so the model must invoke them
                options.toolMode = vscode.LanguageModelChatToolMode.Required;
                options.tools = [...tools];
            } else {
                options.toolMode = undefined;
                options.tools = [...tools];
            }

            const response = await model.sendRequest(messages, options, token);
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let responseStr = '';

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    responseStr += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    if (part.name === 'cogent_updateFile' || part.name === 'cogent_applyDiff') {
                        hasFileUpdateCall = true;
                    }
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
                        processedPrompt
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

    // Register the apply changes command
    const applyChangesCommand = vscode.commands.registerCommand('cogent.applyChanges', async () => {
        await vscode.workspace.saveAll();
        vscode.window.showInformationMessage('All changes have been saved');
    });

    context.subscriptions.push(toolUser, applyChangesCommand);
}
