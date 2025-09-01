import * as vscode from 'vscode';
import { RemoveFileTool } from './tools';
import { DiffView } from './components/DiffView';
import { Logger } from './components/Logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('Cogent extension is now active!');

    // Register only the file/remove tool — other operations should use Copilot built-in tools by default.
    context.subscriptions.push(
        vscode.lm.registerTool('cogent_removeFile', new RemoveFileTool())
    );
    
    // Note: semantic search and other tools are expected to be provided by Copilot built-in tools.
}

export function deactivate() {
    Logger.getInstance().dispose();
    DiffView.dispose();
}
