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

        // Summarize chat history to ensure previous turns are visible to the model even if
        // instanceof checks fail across module boundaries. We keep the summary short.
        // This implementation performs a local compression and optionally calls the selected model
        // to produce a short/high-quality summary when configured to do so.
        async function summarizeHistory(ctx: vscode.ChatContext, model: vscode.LanguageModelChat, token: vscode.CancellationToken): Promise<string> {
            try {
                if (!ctx?.history || !ctx.history.length) return '';
                const maxTurns = 50;
                const recentKeep = 20; // 直近は生で渡す（要調整可）
                const parts: string[] = [];

                const extractTextFromTurn = (turn: any): string => {
                    try {
                        if (turn?.prompt && typeof turn.prompt === 'string') return `User: ${turn.prompt}`;
                        if (turn?.response && Array.isArray(turn.response)) {
                            const text = (turn.response as any[])
                                .map((r: any) => {
                                    try {
                                        if (r?.value?.value && typeof r.value.value === 'string') return String(r.value.value);
                                        if (r?.value?.fsPath) return String(r.value.fsPath);
                                        if (r?.value?.uri && r.value.uri.fsPath) return String(r.value.uri.fsPath);
                                        if (typeof r === 'string') return r;
                                    } catch {}
                                    return '';
                                })
                                .filter(Boolean)
                                .join(' ');
                            if (text) return `Assistant: ${text}`;
                        }
                    } catch {}
                    return '';
                };

                const history = ctx.history as any[];
                // If short enough, just take up to maxTurns
                if (history.length <= maxTurns) {
                    for (const turn of history.slice(-maxTurns)) {
                        const t = extractTextFromTurn(turn);
                        if (t) parts.push(t);
                    }
                    return parts.join('\n');
                }

                // history is long -> compress older turns, keep recentKeep turns verbatim
                const recent = history.slice(-recentKeep);
                const older = history.slice(0, Math.max(0, history.length - recentKeep));

                // Create a lightweight compression of older turns:
                // take short excerpt from each (first 200 chars of extracted text), dedupe adjacent repeats,
                // then join with " | " and cap total length to avoid huge prompts.
                const compressedPieces: string[] = [];
                for (const turn of older) {
                    const txt = extractTextFromTurn(turn).replace(/\s+/g, ' ').trim();
                    if (!txt) continue;
                    const excerpt = txt.length > 200 ? txt.slice(0, 200) + '…' : txt;
                    // avoid adding the same excerpt repeatedly
                    if (compressedPieces.length === 0 || compressedPieces[compressedPieces.length - 1] !== excerpt) {
                        compressedPieces.push(excerpt);
                    }
                    if (compressedPieces.length >= 100) break; // safety cap on pieces
                }

                let compressedSummary = compressedPieces.join(' | ');
                if (compressedSummary.length > 800) compressedSummary = compressedSummary.slice(0, 800) + '…';

                // Optionally use the model to further condense the compressedSummary into a short high-quality summary
                const useModelSummary = vscode.workspace.getConfiguration('cogent').get('use_model_history_summary', true);
                if (useModelSummary && model) {
                    try {
                        // Build a small prompt instructing the model to summarize
                        const sys = [{ role: 'system', content: 'あなたは会話履歴の要約者です。古い履歴の要点だけを3行以内で簡潔にまとめてください。個人情報を削除し、事実のみを残してください。' } as any];
                        const user = [{ role: 'user', content: `要約対象:
${compressedSummary}

短く日本語で3行以内の要約を出してください。` } as any];
                        const msg = [...sys, ...user];

                        // Fire a lightweight request to the model
                        const resp = await (model as any).sendRequest(msg, { justification: 'history-summary' } as any, token);
                        let summaryText = '';
                        for await (const part of resp.stream) {
                            // try to read text parts in a defensive way
                            if (part instanceof vscode.LanguageModelTextPart) {
                                summaryText += part.value;
                            } else if ((part as any).value && typeof (part as any).value === 'string') {
                                summaryText += (part as any).value;
                            }
                        }

                        summaryText = summaryText.trim();
                        if (summaryText) {
                            // crop to safe length
                            if (summaryText.length > 800) summaryText = summaryText.slice(0, 800) + '…';
                            return `[SUMMARY of earlier ${older.length} turns]: ${summaryText}`;
                        }
                    } catch (err) {
                        // ignore model errors and fall back to local compressed summary
                        try { console.debug('history summary model call failed: ' + String(err)); } catch {}
                    }
                }

                // Fallback: return local compressed summary
                parts.push(`[SUMMARY of earlier ${older.length} turns]: ${compressedSummary}`);

                // Append recent turns uncompressed (up to recentKeep)
                for (const turn of recent) {
                    const t = extractTextFromTurn(turn);
                    if (t) parts.push(t);
                }

                // If still too long, take last maxTurns of the assembled parts
                const assembled = parts.join('\n').split('\n');
                if (assembled.length > maxTurns) {
                    return assembled.slice(-maxTurns).join('\n');
                }
                return assembled.join('\n');
            } catch {
                return '';
            }
        }

        const historySummary = await summarizeHistory(chatContext, model, token);
        const procPrompt = historySummary ? `${historySummary}\n\n${request.prompt}` : request.prompt;

        const result = await renderPrompt(
            ToolUserPrompt,
            {
                context: chatContext,
                request,
                toolCallRounds: [],
                toolCallResults: {},
                processedPrompt: procPrompt
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
                // A specific tool was requested by the chat request; require that single tool.
                options.toolMode = vscode.LanguageModelChatToolMode.Required;
                options.tools = vscode.lm.tools.filter(tool => tool.name === requestedTool.name);
            } else if (alwaysUseTools) {
                // If configured to always use tools, prefer to make a single preferred tool Required.
                // Note: LanguageModelChatToolMode.Required is not supported with more than one tool,
                // so only set Required when we have exactly one tool to require.
                if (tools.length === 1) {
                    options.toolMode = vscode.LanguageModelChatToolMode.Required;
                    options.tools = [...tools];
                } else {
                    // Multiple tools present — do not set Required (unsupported). Provide the tools
                    // but leave toolMode undefined so the model can choose to call them.
                    options.toolMode = undefined;
                    options.tools = [...tools];
                }
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

    // Register the apply changes command
    const applyChangesCommand = vscode.commands.registerCommand('cogent.applyChanges', async () => {
        await vscode.workspace.saveAll();
        vscode.window.showInformationMessage('All changes have been saved');
    });

    context.subscriptions.push(toolUser, applyChangesCommand);
}
