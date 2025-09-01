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

// --- 追加: 安全に model.sendRequest のレスポンスを扱うユーティリティ ---
function isAsyncIterable(obj: any): obj is AsyncIterable<any> {
    return !!obj && typeof obj[Symbol.asyncIterator] === 'function';
}

/**
 * model.sendRequest のレスポンスは実装によって形が異なるため、
 * - AsyncIterable (直接)
 * - { stream: AsyncIterable }
 * - Array of parts
 * - { parts: Array }
 * のいずれにも対応して安全にパートを反復処理します。
 */
async function consumeResponsePartsSafely(response: any,
    onPart: (part: any) => Promise<void> | void, token?: vscode.CancellationToken) {
    try {
        // 1) response が AsyncIterable の場合
        if (isAsyncIterable(response)) {
            for await (const part of response) {
                if (token?.isCancellationRequested) break;
                if (part == null) continue; // defensive: skip null/undefined parts
                try { await onPart(part); } catch (e) { console.warn('Error processing stream part:', e); }
            }
            return;
        }

        // 2) response.stream が AsyncIterable の場合
        if (response && isAsyncIterable(response.stream)) {
            for await (const part of response.stream) {
                if (token?.isCancellationRequested) break;
                if (part == null) continue; // defensive
                try { await onPart(part); } catch (e) { console.warn('Error processing stream part:', e); }
            }
            return;
        }

        // 3) response が配列（parts の配列など）の場合
        if (Array.isArray(response)) {
            for (const part of response) {
                if (token?.isCancellationRequested) break;
                if (part == null) continue; // defensive
                try { await onPart(part); } catch (e) { console.warn('Error processing array part:', e); }
            }
            return;
        }

        // 4) response.parts が配列の場合
        if (response && Array.isArray(response.parts)) {
            for (const part of response.parts) {
                if (token?.isCancellationRequested) break;
                if (part == null) continue; // defensive
                try { await onPart(part); } catch (e) { console.warn('Error processing parts array part:', e); }
            }
            return;
        }

        // 5) 単一のテキスト値や value を持つ場合は単発で処理
        if (response && (typeof response === 'string' || (response.value && typeof response.value === 'string'))) {
            try { await onPart(response.value ? { value: response.value } : { value: response }); } catch (e) { console.warn('Error processing single-part response:', e); }
            return;
        }

        // 6) どれにも当てはまらない場合はログに残して終了
        console.warn('consumeResponsePartsSafely: response had no iterable parts', response);
    } catch (err) {
        console.warn('Error consuming response parts safely:', err);
    }
}
// --- 追加ここまで ---

export function registerToolUserChatParticipant(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Cogent');
    const log = {
        debug: (m: any) => { try { output.appendLine('[debug] ' + (typeof m === 'string' ? m : JSON.stringify(m))); } catch { }; try { console.debug(m); } catch { } },
        info: (m: any) => { try { output.appendLine('[info] ' + (typeof m === 'string' ? m : JSON.stringify(m))); } catch { }; try { console.log(m); } catch { } },
        warn: (m: any) => { try { output.appendLine('[warn] ' + (typeof m === 'string' ? m : JSON.stringify(m))); } catch { }; try { console.warn(m); } catch { } },
        error: (m: any) => { try { output.appendLine('[error] ' + (typeof m === 'string' ? m : JSON.stringify(m))); } catch { }; try { console.error(m); } catch { } }
    };
    // We'll create the chat participant below but declare it here so the handler
    // can update the participant's name at runtime based on the selected model.
    let toolUser: vscode.ChatParticipant | undefined;

    function getModelDisplayName(model: vscode.LanguageModelChat | undefined): string {
        if (!model) return 'unknown-model';
        const anyM: any = model as any;
        if (!anyM) return 'unknown-model';
        return (anyM.displayName || anyM.name || anyM.id || `${anyM.vendor ?? ''}/${anyM.family ?? ''}`).toString();
    }

    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
        try {
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
                if (models && models.length > 0) {
                    model = models[0];
                }
                if (!model) {
                    models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
                    if (models && models.length > 0) {
                        model = models[0];
                    }
                }
            }


            // (intentionally left blank) do not modify the chat participant's displayed name

            if (!model) {
                // Nothing we can do without a model; inform the user and stop handling this request.
                stream.markdown("No language model available.");
                return;
            }

            const useFullWorkspace = vscode.workspace.getConfiguration('cogent').get('use_full_workspace', false);
            // New config to control whether we should always prefer using tools
            const alwaysUseTools = vscode.workspace.getConfiguration('cogent').get('alwaysUseTools', true);

                // Only expose a minimal set of cogent_* tools (file operations) to this participant.
                // All other non-file tools should be provided by Copilot (vendor-provided tools).
                const allowedCogent = new Set([
                    'cogent_createFile',
                    'cogent_getAbsolutePath',
                    'cogent_overwriteFile',
                    'cogent_removeFile'
                ]);

                const allLmTools = Array.isArray(vscode.lm.tools) ? vscode.lm.tools : [];
                const cogentFileTools = allLmTools.filter(t => typeof t?.name === 'string' && allowedCogent.has(t.name));

                // Include Copilot-provided tools (or getvscodeapi) so the model can call them.
                const copilotAndApiTools = allLmTools.filter(t => {
                    if (!t || typeof t.name !== 'string') return false;
                    const n = t.name.toLowerCase();
                    return n === 'cogent_getvscodeapi' || n.includes('copilot') || n.includes('getvscodeapi');
                });

                // Merge and dedupe by name
                const byName = new Map<string, typeof allLmTools[0]>();
                for (const t of [...cogentFileTools, ...copilotAndApiTools]) {
                    if (t && typeof t.name === 'string' && !byName.has(t.name)) byName.set(t.name, t);
                }
                let tools = Array.from(byName.values());

            const options: vscode.LanguageModelChatRequestOptions = {
                justification: 'To make a request to Cogent',
            };


        async function summarizeHistory(ctx: vscode.ChatContext, _model: vscode.LanguageModelChat, _token: vscode.CancellationToken): Promise<string> {
            try {
                if (!ctx?.history || !ctx.history.length) return '';
                const maxTurns = 50;

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
                                    } catch { }
                                    return '';
                                })
                                .filter(Boolean)
                                .join(' ');
                            if (text) return `Assistant: ${text}`;
                        }
                    } catch { }
                    return '';
                };

                const history = (ctx.history as any[]).slice(-maxTurns);
                const parts = history.map(h => extractTextFromTurn(h)).filter(Boolean);
                return parts.join('\n');
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

            let response: any;
            try {
                response = await model.sendRequest(messages, options, token);
            } catch (err) {
                // Log detailed error and inform the user via the chat stream
                try { log.error({ msg: 'runWithTools: model.sendRequest failed', err }); } catch { }
                try { stream.markdown('Error: failed to get a response from the language model. See extension console for details.'); } catch { }
                return;
            }
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let responseStr = '';

            await consumeResponsePartsSafely(response, (part: any) => {
                try {
                    // defensive property-based type detection to avoid `instanceof` across realms
                    const val = part && (part.value ?? (part as any).text ?? (part as any).content);
                    const isText = val && (typeof val === 'string' || typeof (val?.value) === 'string');
                    if (isText) {
                        const text = typeof val === 'string' ? val : (val.value ?? val).toString();
                        try { stream.markdown(text); } catch { /* ignore */ }
                        responseStr += text;
                        return;
                    }

                    const isToolCall = !!part && typeof (part as any).name === 'string';
                    if (isToolCall) {
                        const p: any = part;
                        if (p.name === 'cogent_updateFile' || p.name === 'cogent_applyDiff') {
                            hasFileUpdateCall = true;
                        }
                        toolCalls.push(p);
                        return;
                    }

                    try { log.debug({ msg: 'Unhandled stream part type', part }); } catch { }
                } catch (e) {
                    // Safely log and ignore malformed part
                    try { log.warn({ msg: 'Error processing part (malformed)', e, part }); } catch { }
                }
            }, token);

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
        } catch (err) {
            try { log.error({ msg: 'handler error', err }); } catch {}
            try { stream.markdown('Internal error in Cogent participant: ' + ((err as any)?.message || String(err))); } catch {}
            // Return a safe, empty metadata object to satisfy the contract
            return {
                metadata: {
                    toolCallsMetadata: {
                        toolCallResults: {},
                        toolCallRounds: []
                    }
                } as unknown as TsxToolUserMetadata
            };
        }
    };

    toolUser = vscode.chat.createChatParticipant('cogent.assistant', handler);
    toolUser!.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets/cogent.jpeg');

    // Register the apply changes command
    const applyChangesCommand = vscode.commands.registerCommand('cogent.applyChanges', async () => {
        await vscode.workspace.saveAll();
        vscode.window.showInformationMessage('All changes have been saved');
    });

    context.subscriptions.push(toolUser!, applyChangesCommand);

}
