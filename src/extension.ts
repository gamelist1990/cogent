import * as vscode from 'vscode';
import { registerToolUserChatParticipant } from './toolParticipant';
import { RemoveFileTool, RunCommandTool } from './tools';
import { DiffView } from './components/DiffView';
import { Logger } from './components/Logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('Cogent extension is now active!');

    // Register file tools — other operations should use Copilot built-in tools by default.
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool())
    );
    // Create file tool for safe creation of new files via the language model.
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_createFile', new (require('./tools').CreateFileTool)())
    );

    // Run command tool
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_runCommand', new (require('./tools').RunCommandTool)())
    );



    // Register the tool participant
    registerToolUserChatParticipant(context);

    // Note: semantic search and other tools are expected to be provided by Copilot built-in tools.
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}
