import * as vscode from 'vscode';
import { Logger } from '../components/Logger';

interface IGetErrorInput {
    filePaths?: string[];
}

export class GetErrorTool implements vscode.LanguageModelTool<IGetErrorInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetErrorInput>,
        _token: vscode.CancellationToken
    ) {
        const logger = Logger.getInstance();
        const filePaths = options.input.filePaths || [];

        logger.info(`Running getErrorTool for files: ${filePaths.join(', ')}`);

        const allDiagnostics = vscode.languages.getDiagnostics();
        const filtered = allDiagnostics.filter(([uri, diags]) => {
            if (filePaths.length === 0) return true;
            return filePaths.some(fp => uri.fsPath === fp);
        });

        const results: string[] = [];
        for (const [uri, diags] of filtered) {
            if (diags.length > 0) {
                const errors = diags.map(d => `  Line ${d.range.start.line + 1}: ${vscode.DiagnosticSeverity[d.severity]} - ${d.message}`);
                results.push(`${uri.fsPath}:\n${errors.join('\n')}`);
            }
        }

        const body = results.length ? results.join('\n\n') : 'No errors found';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)]);
    }

    async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IGetErrorInput>) {
        return { invocationMessage: 'Getting errors from files or workspace' };
    }
}
