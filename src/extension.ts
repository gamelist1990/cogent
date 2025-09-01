import * as vscode from 'vscode';
import { registerToolUserChatParticipant } from './toolParticipant';
import { FileReadTool, FileWriteTool, FileUpdateTool, CommandRunTool, ApplyDiffTool, RemoveFileTool, GetChangedFilesTool, WebSearchTool, FetchWebpageTool, GetVscodeApiTool, ThinkTool, FormatUserInputTool } from './tools';
import { DiffView } from './components/DiffView';
import { Logger } from './components/Logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('Cogent extension is now active!');

    // Register tools
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_readFile', new FileReadTool()),
        vscode.lm.registerTool('cogent_writeFile', new FileWriteTool()),
        vscode.lm.registerTool('cogent_updateFile', new FileUpdateTool()),
    vscode.lm.registerTool('cogent_runCommand', new CommandRunTool()),
    vscode.lm.registerTool('cogent_formatUserInput', new FormatUserInputTool()),
        vscode.lm.registerTool('cogent_applyDiff', new ApplyDiffTool()),
        vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool()),
        vscode.lm.registerTool('cogent_getChangedFiles', new GetChangedFilesTool()),
        vscode.lm.registerTool('cogent_webSearch', new WebSearchTool()),
        vscode.lm.registerTool('cogent_fetchWebpage', new FetchWebpageTool()),
        vscode.lm.registerTool('cogent_getVscodeApi', new GetVscodeApiTool()),
        vscode.lm.registerTool('cogent_think', new ThinkTool())
    );

    // Command wrapper so the UI can trigger formatting via a command link
    const disposableFormat = vscode.commands.registerCommand('cogent.formatUserInput', async (initialText?: string) => {
        try {
            const text = initialText ?? '';
            const token = new vscode.CancellationTokenSource().token;
            const result = await vscode.lm.invokeTool('cogent_formatUserInput', { input: { text, style: 'polish' }, toolInvocationToken: undefined }, token);
            const anyRes: any = result;
            const formatted = (anyRes?.parts ?? []).map((p: any) => p?.text ?? p?.value ?? '').join('') ?? '';
            if (!formatted) {
                void vscode.window.showInformationMessage('Formatting returned empty result');
                return;
            }
            await vscode.env.clipboard.writeText(formatted);
            void vscode.window.showInformationMessage('Formatted text copied to clipboard. Paste into the chat input to use it.');
        } catch (err) {
            void vscode.window.showErrorMessage(`Formatting failed: ${(err as Error).message}`);
        }
    });
    context.subscriptions.push(disposableFormat);

    // Register the tool participant
    registerToolUserChatParticipant(context);
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}
