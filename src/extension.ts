import * as vscode from 'vscode';
import { registerToolUserChatParticipant } from './toolParticipant';
import { RemoveFileTool } from './tools';
import { DiffView } from './components/DiffView';
import { Logger } from './components/Logger';
import { CreateFileTool } from './tools/CreateFileTool';
import { OverwriteFileTool } from './tools/OverwriteFileTool';
import { GetAbsolutePathTool } from './tools/GetAbsolutePathTool';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('Cogent extension is now active!');

    // Register only the file/remove tool — other operations should use Copilot built-in tools by default.
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool()),
        vscode.lm.registerTool('cogent_createFile', new CreateFileTool()),
        vscode.lm.registerTool('cogent_overwriteFile', new OverwriteFileTool()),
        vscode.lm.registerTool('cogent_getAbsolutePath', new GetAbsolutePathTool()),
    );



    // Register the tool participant
    registerToolUserChatParticipant(context);

    // Note: semantic search and other tools are expected to be provided by Copilot built-in tools.
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}
