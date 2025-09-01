export function preInvokeHint(toolName: string, target?: string) {
    const targetInfo = target ? ` target='${target}'` : '';
    return `Before running ${toolName}${targetInfo}, please run list_code_usages to discover definitions and all references that might be affected.`;
}

export function postSuccessHint(toolName: string) {
    return `After ${toolName} completes, run get_errors and fix any reported issues until none remain.`;
}

export function postErrorHint(toolName: string, errMessage?: string) {
    const err = errMessage ? ` Error: ${errMessage}` : '';
    return `Error in ${toolName}.${err} After addressing the problem, run get_errors to verify there are no remaining errors.`;
}
