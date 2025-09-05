import * as vscode from 'vscode';

export class Logger {
    private static instance: Logger;
    private channel: vscode.OutputChannel;

    private constructor() {
        this.channel = vscode.window.createOutputChannel('Cogent', { log: true });
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    info(message: string): void {
        this.channel.appendLine(`INFO: ${message}`);
    }

    warn(message: string): void {
        this.channel.appendLine(`WARN: ${message}`);
    }

    error(message: string | Error): void {
        if (message instanceof Error) {
            this.channel.appendLine(`ERROR: ${message.stack || message.message}`);
        } else {
            this.channel.appendLine(`ERROR: ${message}`);
        }
    }

    debug(message: string): void {
        this.channel.appendLine(`DEBUG: ${message}`);
    }

    // Path debugging helper
    debugPath(operation: string, originalPath: string, processedPath: string, workspacePath?: string): void {
        this.debug(`${operation}: original="${originalPath}" processed="${processedPath}" workspace="${workspacePath || 'N/A'}"`);
    }

    show(): void {
        this.channel.show();
    }

    dispose(): void {
        this.channel.dispose();
    }
}