import * as vscode from 'vscode';

interface IFormatInput {
    text: string;
    style?: 'concise' | 'polish' | 'none';
}

export class FormatUserInputTool implements vscode.LanguageModelTool<IFormatInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFormatInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const text = options.input.text ?? '';
            const style = options.input.style ?? 'polish';

            // Simple local formatting/cleanup rules. Keep deterministic and local-only.
            let out = text
                .replace(/[ \t]+/g, ' ') // collapse multiple spaces
                .replace(/\n{3,}/g, '\n\n') // collapse many newlines
                .trim();

            if (style === 'concise') {
                // Remove filler phrases (very small heuristic)
                out = out
                    .replace(/\b(um|uh|well|so|like)\b/gi, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
            } else if (style === 'polish') {
                // Ensure punctuation spacing for English and basic Japanese spacing rules
                out = out
                    .replace(/\s+([,.!?;:])/g, '$1') // remove space before punctuation
                    .replace(/([,.!?;:])([^\s])/g, '$1 $2') // ensure single space after punctuation
                    .replace(/\s+。/g, '。')
                    .replace(/。([^\s])/g, '。 $1')
                    .replace(/\u3000/g, ' '); // convert ideographic space to normal
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(out)
            ]);
        } catch (err: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error formatting input: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFormatInput>,
        _token: vscode.CancellationToken
    ) {
        // No interactive confirmation required for non-destructive local formatting
        return { invocationMessage: `Format user input (style: ${options.input.style ?? 'polish'})` };
    }
}
