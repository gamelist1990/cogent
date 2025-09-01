import * as vscode from 'vscode';
import { registerToolUserChatParticipant } from './toolParticipant';
import { FileReadTool, FileWriteTool, FileUpdateTool, CommandRunTool, ApplyDiffTool, RemoveFileTool, GetChangedFilesTool, WebSearchTool, FetchWebpageTool, GetVscodeApiTool } from './tools';
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
    vscode.lm.registerTool('cogent_applyDiff', new ApplyDiffTool()),
    vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool()),
    vscode.lm.registerTool('cogent_getChangedFiles', new GetChangedFilesTool()),
    vscode.lm.registerTool('cogent_webSearch', new WebSearchTool()),
    vscode.lm.registerTool('cogent_fetchWebpage', new FetchWebpageTool()),
    vscode.lm.registerTool('cogent_getVscodeApi', new GetVscodeApiTool())
    );

    // Register the tool participant
    registerToolUserChatParticipant(context);
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}