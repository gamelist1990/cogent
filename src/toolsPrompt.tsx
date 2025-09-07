import {
  AssistantMessage,
  BasePromptElementProps,
  Chunk,
  PrioritizedList,
  PromptElement,
  PromptElementProps,
  PromptMetadata,
  PromptPiece,
  PromptReference,
  PromptSizing,
  ToolCall,
  ToolMessage,
  UserMessage,
} from "@vscode/prompt-tsx";
import { ToolResult } from "@vscode/prompt-tsx/dist/base/promptElements";
import * as vscode from "vscode";
import { isTsxToolUserMetadata } from "./toolParticipant";
import { listImportantFiles } from "./components/listFiles";
import * as fs from "fs/promises";
import * as path from "path";
import normalizeToWorkspaceFile, { deepNormalizePathFields, tryNormalizeIfInside } from './components/path';

// Helper function to detect external paths in tool invocation input
function checkForExternalPaths(input: any, workspaceFolder?: vscode.WorkspaceFolder): string[] {
  const externalPaths: string[] = [];
  const pathKeys = new Set(['path','filePath','file','filename']);
  const arrayKeys = new Set(['files','paths']);

  const visit = (obj: any, keyPath: string = '') => {
    if (obj == null || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => visit(item, `${keyPath}[${index}]`));
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = keyPath ? `${keyPath}.${key}` : key;
      
      if (typeof value === 'string' && pathKeys.has(key)) {
        const norm = tryNormalizeIfInside(value, workspaceFolder);
        Logger.getInstance().debug(`External path check: ${key}=${value} -> norm=${norm ? 'inside' : 'outside'}`);
        if (!norm) {
          externalPaths.push(`${currentPath}=${value}`);
        }
      } else if (Array.isArray(value) && arrayKeys.has(key)) {
        value.forEach((item, index) => {
          if (typeof item === 'string') {
            const norm = tryNormalizeIfInside(item, workspaceFolder);
            if (!norm) {
              externalPaths.push(`${currentPath}[${index}]=${item}`);
            }
          }
        });
      } else if (typeof value === 'object') {
        visit(value, currentPath);
      }
    }
  };

  visit(input);
  return externalPaths;
}
import { Logger } from "./components/Logger";
import { buildPrompt } from "./prompt";

export interface ToolCallRound {
  response: string;
  toolCalls: vscode.LanguageModelToolCallPart[];
}

export interface ToolUserProps extends BasePromptElementProps {
  request: vscode.ChatRequest;
  context: vscode.ChatContext;
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  processedPrompt?: string;
}

export class ToolUserPrompt extends PromptElement<ToolUserProps, void> {
  private async getCustomInstructions(): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return "";
    }

    try {
      const rulesPath = path.join(workspaceFolder.uri.fsPath, ".cogentrules");
      const content = await fs.readFile(rulesPath, "utf-8");
      return content.trim();
    } catch (error) {
      // File doesn't exist or can't be read, return empty string
      return "";
    }
  }

  private getProjectStructure() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { structure: "No workspace folder found", contents: {} };
    }
    return listImportantFiles(workspaceFolder.uri.fsPath);
  }

  private getOSLevel(): string {
    return process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
      ? "macOS"
      : "Linux";
  }

  private getShellType(): string {
    return process.platform === "win32"
      ? "PowerShell"
      : process.platform === "darwin"
      ? "zsh"
      : "bash";
  }

  private addLineNumbers(content: string, startLine: number = 1): string {
    const lines = content.split("\n");
    const maxLineNumberWidth = String(startLine + lines.length - 1).length;
    return lines
      .map((line, index) => {
        const lineNumber = String(startLine + index).padStart(
          maxLineNumberWidth,
          " "
        );
        return `${lineNumber} | ${line}`;
      })
      .join("\n");
  }

  async render(_state: void, _sizing: PromptSizing) {
    const logger = Logger.getInstance();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const { structure, contents } = this.getProjectStructure();
    logger.info(`Project file structure:\n ${structure}`);
    const useFullWorkspace = vscode.workspace
      .getConfiguration("cogent")
      .get("use_full_workspace", true);
    const customInstructions = await this.getCustomInstructions();
    const osLevel = this.getOSLevel();
    const shellType = this.getShellType();

    const fileContentsSection = useFullWorkspace
      ? Object.entries(contents)
          .map(([filePath, content]) => {
            return `\n${"=".repeat(80)}\n📝 File: ${filePath}\n${"=".repeat(
              80
            )}\n${this.addLineNumbers(content)}`;
          })
          .join("\n")
      : "";

    const promptText = buildPrompt({
      structure,
      fileContentsSection,
      customInstructions,
      osLevel,
      shellType,
      useFullWorkspace,
      workspacePath: workspaceFolder?.uri.fsPath,
      requestPrompt: this.props.processedPrompt || this.props.request.prompt,
    });

    return (
      <>
        <UserMessage>{promptText}</UserMessage>
        <History context={this.props.context} priority={10} />
        <PromptReferences
          references={this.props.request.references}
          workspaceFolder={workspaceFolder}
        />
        <UserMessage>
          {this.props.processedPrompt || this.props.request.prompt}
        </UserMessage>
        <ToolCalls
          toolCallRounds={this.props.toolCallRounds}
          toolInvocationToken={this.props.request.toolInvocationToken}
          toolCallResults={this.props.toolCallResults}
        />
      </>
    );
  }
}

interface ToolCallsProps extends BasePromptElementProps {
  toolCallRounds: ToolCallRound[];
  toolCallResults: Record<string, vscode.LanguageModelToolResult>;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

const dummyCancellationToken: vscode.CancellationToken =
  new vscode.CancellationTokenSource().token;

class ToolCalls extends PromptElement<ToolCallsProps, void> {
  async render(_state: void, _sizing: PromptSizing) {
    if (!this.props.toolCallRounds.length) {
      return undefined;
    }

    return (
      <>
        {this.props.toolCallRounds.map((round) =>
          this.renderOneToolCallRound(round)
        )}
        <UserMessage>
          Above is the result of calling one or more tools. The user cannot see
          the results, so you should explain them to the user if referencing
          them in your answer.
        </UserMessage>
      </>
    );
  }

  private renderOneToolCallRound(round: ToolCallRound) {
    const assistantToolCalls: ToolCall[] = round.toolCalls.map((tc) => ({
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
      id: tc.callId,
    }));

    return (
      <Chunk>
        <AssistantMessage toolCalls={assistantToolCalls}>
          {round.response}
        </AssistantMessage>
        {round.toolCalls.map((toolCall) => (
          <ToolResultElement
            toolCall={toolCall}
            toolInvocationToken={this.props.toolInvocationToken}
            toolCallResult={this.props.toolCallResults[toolCall.callId]}
          />
        ))}
      </Chunk>
    );
  }
}

interface ToolResultElementProps extends BasePromptElementProps {
  toolCall: vscode.LanguageModelToolCallPart;
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
  toolCallResult: vscode.LanguageModelToolResult | undefined;
}

class ToolResultElement extends PromptElement<ToolResultElementProps, void> {
  async render(
    state: void,
    sizing: PromptSizing
  ): Promise<PromptPiece | undefined> {
    const logger = Logger.getInstance();
    const tool = vscode.lm.tools.find(
      (t) => t.name === this.props.toolCall.name
    );
    if (!tool) {
      logger.error(`Tool not found: ${this.props.toolCall.name}`);
      return (
        <ToolMessage toolCallId={this.props.toolCall.callId}>
          Tool not found
        </ToolMessage>
      );
    }

    const tokenizationOptions: vscode.LanguageModelToolTokenizationOptions = {
      tokenBudget: sizing.tokenBudget,
      countTokens: async (content: string) => sizing.countTokens(content),
    };

    let toolResult: vscode.LanguageModelToolResult | undefined =
      this.props.toolCallResult;
    try {
      if (!toolResult) {
        // Defensive sanitization: models sometimes emit JSON-like strings that represent
        // patch objects (e.g. '{"path":"src/...","content":"..."}'). Passing those
        // directly to tools can cause accidental double-serialization or writes. Try to
        // detect and parse such strings into objects before invoking the tool. If parsing
        // fails or the input still looks dangerous, invoke the tool with the original input
        // but log the event and return a safe message.
        let invocationInput: any = this.props.toolCall.input;
        const logger = Logger.getInstance();

        const tryParseJson = (s: string) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        };

        try {
          // If the model emitted a JSON string, parse it and use the object.
          if (typeof invocationInput === "string") {
            const parsed = tryParseJson(invocationInput);
            if (parsed && typeof parsed === "object") {
              invocationInput = parsed;
            }
          }

          // If some fields inside the input are themselves JSON strings, parse and merge them.
          if (invocationInput && typeof invocationInput === "object") {
            const candidateKeys = ["content", "patch", "input", "data"];
            for (const key of candidateKeys) {
              if (typeof invocationInput[key] === "string") {
                const inner = tryParseJson(invocationInput[key]);
                if (inner && typeof inner === "object") {
                  // Merge inner fields into the top-level invocation object to avoid
                  // losing important fields such as patch/stream/content.
                  invocationInput = { ...invocationInput, ...inner };
                }
              }
            }
          }

          // Best-effort: prefer invoking the tool with the (possibly merged) object
          // rather than refusing. This avoids dropping valid patch text that might
          // be nested or stringified by intermediate steps.
          // Diagnostic logging: record the shape/size of the invocation input to aid
          // debugging when applyPatch reports missing patch text or stream.
          try {
            // Special-case guard: some tools (applyPatch variants) require a 'patch' or stream body.
            // If the model produced an object lacking that content, avoid calling invokeTool which
            // will raise a confusing "Missing patch text or stream" error. Instead, try to
            // recover a patch from common nested fields or return a helpful ToolMessage.
            const toolName = this.props.toolCall.name || '';
            const looksLikeApplyPatch = /applypatch|apply_patch|applyPatch/i.test(toolName) || toolName === 'copilot_applyPatch';
            if (looksLikeApplyPatch && invocationInput && typeof invocationInput === 'object') {
              const hasPatchString = (typeof invocationInput.patch === 'string' && invocationInput.patch.trim().length > 0)
                || (typeof invocationInput.stream === 'string' && invocationInput.stream.trim().length > 0);

              if (!hasPatchString) {
                // Attempt to extract patch text from common nested fields before giving up.
                // Be more permissive: accept typical diff/unified markers even when the
                // model omitted explicit "*** Begin Patch" markers.
                const candidateKeys = ['input', 'content', 'data', 'patch', 'patchText', 'edits', 'patches'];
                const isPatchLike = (s: string) => {
                  return (
                    s.includes('*** Begin Patch') ||
                    s.includes('*** Update File') ||
                    s.includes('*** End Patch') ||
                    s.includes('@@ ') ||
                    s.includes('diff --git') ||
                    s.split('\n').slice(0, 10).some(line => /^\*{3}\s/.test(line)) ||
                    s.split('\n').some(line => /^\+{1}.+|^-{1}.+/.test(line))
                  );
                };

                for (const key of candidateKeys) {
                  const val = invocationInput[key];
                  if (typeof val === 'string') {
                    // If the string looks like a patch/diff, adopt it as the patch text.
                    if (val.includes('*** Begin Patch') || isPatchLike(val)) {
                      invocationInput.patch = val;
                      Logger.getInstance().info(`Recovered patch from field '${key}', length=${val.length}`);
                      break;
                    }
                    // If the field holds JSON-stringified patch content, try to parse it
                    // (handled earlier), otherwise continue scanning.
                  }

                  if (Array.isArray(val) && val.length) {
                    // If it's an array of strings, join and inspect for patch markers.
                    if (val.every((e: any) => typeof e === 'string')) {
                      const joined = (val as string[]).join('\n');
                      if (joined.includes('*** Begin Patch') || isPatchLike(joined)) {
                        invocationInput.patch = joined;
                        Logger.getInstance().info(`Recovered patch from array field '${key}', length=${joined.length}`);
                        break;
                      }
                    }

                    // Small heuristic: if it's an array of objects with {path, content},
                    // construct a minimal v4a-style patch so applyPatch tools can accept it.
                    if (val.every((e: any) => e && typeof e === 'object' && typeof e.path === 'string' && typeof e.content === 'string')) {
                      const built = (val as any[])
                        .map(item => `*** Begin Patch\n*** Update File: ${item.path}\n@@\n${item.content}\n*** End Patch`)
                        .join('\n');
                      if (built) {
                        invocationInput.patch = built;
                        Logger.getInstance().info(`Constructed patch from object-array field '${key}', files=${(val as any[]).length}`);
                        break;
                      }
                    }
                  }
                }
              }

              const finallyHasPatch = (typeof invocationInput.patch === 'string' && invocationInput.patch.trim().length > 0)
                || (typeof invocationInput.stream === 'string' && invocationInput.stream.trim().length > 0);

              if (!finallyHasPatch) {
                logger.error(`Refusing to invoke ${toolName}: missing patch/stream text. invocation keys=${Object.keys(invocationInput).join(',')}`);
                return (
                  <ToolMessage toolCallId={this.props.toolCall.callId}>
                    Tool invocation skipped: the tool '{this.props.toolCall.name}' expects patch text or a stream but none was found in the model output.
                    Diagnostic: input type={typeof invocationInput}, keys={Object.keys(invocationInput).join(',')}. See extension logs for details.
                  </ToolMessage>
                );
              }
            }

            if (typeof invocationInput === "string") {
              logger.info(
                `Invoking tool ${this.props.toolCall.name} with string input, length=${invocationInput.length}`
              );
              logger.info(
                `Contains Begin Patch marker: ${invocationInput.includes(
                  "*** Begin Patch"
                )}`
              );
              logger.info(
                `Contains End Patch marker: ${invocationInput.includes(
                  "*** End Patch"
                )}`
              );
            } else if (invocationInput && typeof invocationInput === "object") {
              const topKeys = Object.keys(invocationInput)
                .slice(0, 10)
                .join(",");
              logger.info(
                `Invoking tool ${this.props.toolCall.name} with object input, keys=${topKeys}`
              );
              if (typeof invocationInput.input === "string") {
                logger.info(
                  `Nested 'input' length=${
                    invocationInput.input.length
                  }, contains Begin Patch: ${invocationInput.input.includes(
                    "*** Begin Patch"
                  )}`
                );
              }
            } else {
              logger.info(
                `Invoking tool ${
                  this.props.toolCall.name
                } with ${typeof invocationInput} input`
              );
            }

            // Deep normalize path fields (relative -> absolute inside workspace)
            try {
              const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
              invocationInput = deepNormalizePathFields(invocationInput, workspaceFolder);
              Logger.getInstance().debug(`Deep-normalized invocation input keys=${Object.keys(invocationInput || {}).slice(0,10).join(',')}`);
              
              // Check for workspace-external paths and block tool invocation if found
              const externalPaths = checkForExternalPaths(invocationInput, workspaceFolder);
              Logger.getInstance().debug(`External paths check result: ${externalPaths.length} paths found: ${externalPaths.join(', ')}`);
              
              if (externalPaths.length > 0) {
                Logger.getInstance().warn(`Blocking tool ${this.props.toolCall.name} due to external paths: ${externalPaths.join(', ')}`);
                return (
                  <ToolMessage toolCallId={this.props.toolCall.callId}>
                    Tool invocation blocked: Cannot operate on files outside the current workspace. 
                    External paths detected: {externalPaths.slice(0, 3).join(', ')}
                    {externalPaths.length > 3 ? ` (and ${externalPaths.length - 3} more)` : ''}
                  </ToolMessage>
                );
              }
            } catch (e) {
              Logger.getInstance().debug(`Deep path normalization failed: ${e instanceof Error ? e.message : String(e)}`);
            }

            toolResult = await vscode.lm.invokeTool(
              this.props.toolCall.name,
              {
                input: invocationInput,
                toolInvocationToken: this.props.toolInvocationToken,
                tokenizationOptions,
              },
              dummyCancellationToken
            );
          } catch (invokeErr) {
            // If the underlying tool reports a missing patch/body, capture extra diagnostics
            const invokeMsg =
              invokeErr instanceof Error
                ? invokeErr.message
                : String(invokeErr);
            logger.error(
              `Tool ${this.props.toolCall.name} invocation error: ${invokeMsg}`
            );
            if (
              invokeMsg.includes("Missing patch text") ||
              invokeMsg.includes("Missing patch text or stream")
            ) {
              // Attach a helpful diagnostic message to the user-visible ToolMessage
              return (
                <ToolMessage toolCallId={this.props.toolCall.callId}>
                  Tool invocation failed: {invokeMsg}. Diagnostic: input type=
                  {typeof invocationInput}. See extension logs for invocation
                  input length and markers.
                </ToolMessage>
              );
            }
            throw invokeErr;
          }
        } catch (invokeErr) {
          // rethrow to be handled by outer catch and logged
          throw invokeErr;
        }
      }

      // Defensive: if toolResult is falsy or doesn't contain expected data, provide a safe message
      if (!toolResult) {
        return (
          <ToolMessage toolCallId={this.props.toolCall.callId}>
            Tool returned no result
          </ToolMessage>
        );
      }

      // Some tool results may have missing patch text/stream for certain tool types. Wrap rendering in try/catch
      try {
        // ToolResultのレンダリング前に、toolResultの構造を検証
        // LanguageModelToolResultはpartsプロパティを持つ配列形式
        const toolResultAny = toolResult as any;
        if (!toolResult || (!toolResultAny.patch && !toolResultAny.stream)) {
          // patch や stream が不足している場合は、テキストパートとして処理
          const textParts =
            toolResultAny?.parts?.filter(
              (part: any) => part instanceof vscode.LanguageModelTextPart
            ) || [];
          if (textParts.length > 0) {
            const textContent = textParts
              .map((part: any) => part.value)
              .join("\n");
            return (
              <ToolMessage toolCallId={this.props.toolCall.callId}>
                <meta
                  value={
                    new ToolResultMetadata(
                      this.props.toolCall.callId,
                      toolResult
                    )
                  }
                ></meta>
                {textContent}
              </ToolMessage>
            );
          } else {
            return (
              <ToolMessage toolCallId={this.props.toolCall.callId}>
                Tool completed successfully
              </ToolMessage>
            );
          }
        }

        return (
          <ToolMessage toolCallId={this.props.toolCall.callId}>
            <meta
              value={
                new ToolResultMetadata(this.props.toolCall.callId, toolResult)
              }
            ></meta>
            <ToolResult data={toolResult} />
          </ToolMessage>
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Logger.getInstance().error(
          `Failed to render tool result for ${this.props.toolCall.name}: ${msg}`
        );

        // "Missing patch text or stream" エラーの特別な処理
        if (msg.includes("Missing patch text or stream")) {
          return (
            <ToolMessage toolCallId={this.props.toolCall.callId}>
              Tool completed successfully (result format not supported for
              display)
            </ToolMessage>
          );
        }

        return (
          <ToolMessage toolCallId={this.props.toolCall.callId}>
            Unable to render tool result: {msg}
          </ToolMessage>
        );
      }
    } catch (invokeErr) {
      const msg =
        invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
      Logger.getInstance().error(
        `Tool invocation failed for ${this.props.toolCall.name}: ${msg}`
      );
      return (
        <ToolMessage toolCallId={this.props.toolCall.callId}>
          Tool invocation failed: {msg}
        </ToolMessage>
      );
    }
  }
}

export class ToolResultMetadata extends PromptMetadata {
  constructor(
    public toolCallId: string,
    public result: vscode.LanguageModelToolResult
  ) {
    super();
  }
}

interface HistoryProps extends BasePromptElementProps {
  priority: number;
  context: vscode.ChatContext;
}

class History extends PromptElement<HistoryProps, void> {
  render(_state: void, _sizing: PromptSizing) {
    return (
      <PrioritizedList priority={this.props.priority} descending={false}>
        {this.props.context.history.map((message) => {
          if (message instanceof vscode.ChatRequestTurn) {
            return (
              <>
                <PromptReferences
                  references={message.references}
                  excludeReferences={true}
                />
                <UserMessage>{message.prompt}</UserMessage>
              </>
            );
          } else if (message instanceof vscode.ChatResponseTurn) {
            const metadata = message.result.metadata;
            if (
              isTsxToolUserMetadata(metadata) &&
              metadata.toolCallsMetadata.toolCallRounds.length > 0
            ) {
              return (
                <ToolCalls
                  toolCallResults={metadata.toolCallsMetadata.toolCallResults}
                  toolCallRounds={metadata.toolCallsMetadata.toolCallRounds}
                  toolInvocationToken={undefined}
                />
              );
            }
            return (
              <AssistantMessage>
                {chatResponseToString(message)}
              </AssistantMessage>
            );
          }
        })}
      </PrioritizedList>
    );
  }
}

function chatResponseToString(response: vscode.ChatResponseTurn): string {
  return response.response
    .map((r) => {
      if (r instanceof vscode.ChatResponseMarkdownPart) {
        return r.value.value;
      } else if (r instanceof vscode.ChatResponseAnchorPart) {
        if (r.value instanceof vscode.Uri) {
          return r.value.fsPath;
        } else {
          return r.value.uri.fsPath;
        }
      }
      return "";
    })
    .join("");
}

interface PromptReferencesProps extends BasePromptElementProps {
  references: ReadonlyArray<vscode.ChatPromptReference>;
  excludeReferences?: boolean;
  workspaceFolder?: vscode.WorkspaceFolder;
}

class PromptReferences extends PromptElement<PromptReferencesProps, void> {
  render(_state: void, _sizing: PromptSizing): PromptPiece {
    return (
      <UserMessage>
        {this.props.references.map((ref) => (
          <PromptReferenceElement
            ref={ref}
            excludeReferences={this.props.excludeReferences}
            workspaceFolder={this.props.workspaceFolder}
          />
        ))}
      </UserMessage>
    );
  }
}

interface PromptReferenceProps extends BasePromptElementProps {
  ref: vscode.ChatPromptReference;
  excludeReferences?: boolean;
  workspaceFolder?: vscode.WorkspaceFolder;
}

class PromptReferenceElement extends PromptElement<PromptReferenceProps> {
  async render(
    _state: void,
    _sizing: PromptSizing
  ): Promise<PromptPiece | undefined> {
    const value = this.props.ref.value;
    if (value instanceof vscode.Uri) {
      let uri = value;
      // If the Uri has no scheme and looks like an absolute path (starts with drive or /),
      // don't join it to the workspace folder. Only treat it as workspace-relative when it's a relative path.
      if (!uri.scheme && this.props.workspaceFolder) {
        const raw = uri.fsPath || "";
        const logger = Logger.getInstance();
        try {
          const norm = normalizeToWorkspaceFile(raw, this.props.workspaceFolder);
          uri = norm.uri;
          logger.debugPath("PromptReference-Uri", raw, uri.fsPath, this.props.workspaceFolder.uri.fsPath);
        } catch (e) {
          logger.debug(`Could not normalize path ${raw}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        // If the URI is a directory, avoid readFile which throws EISDIR.
        if (stat.type === vscode.FileType.Directory) {
          const entries = await vscode.workspace.fs.readDirectory(uri);
          const names = entries
            .map(
              ([name, type]) =>
                `${name}${type === vscode.FileType.Directory ? "/" : ""}`
            )
            .join(", ");
          return (
            <Tag name="context">
              {!this.props.excludeReferences && (
                <references value={[new PromptReference(uri)]} />
              )}
              {uri.fsPath}:<br />
              ``` <br />
              Directory contents: {names}
              <br />
              ```
              <br />
            </Tag>
          );
        }

        const fileContents = (
          await vscode.workspace.fs.readFile(uri)
        ).toString();
        return (
          <Tag name="context">
            {!this.props.excludeReferences && (
              <references value={[new PromptReference(uri)]} />
            )}
            {uri.fsPath}:<br />
            ``` <br />
            {fileContents}
            <br />
            ```
            <br />
          </Tag>
        );
      } catch (err) {
        // If anything goes wrong (permissions, EISDIR, etc.), show a safe message.
        const msg = err instanceof Error ? err.message : String(err);
        Logger.getInstance().error(`Failed to read file ${uri.fsPath}: ${msg}`);
        return (
          <Tag name="context">
            {!this.props.excludeReferences && (
              <references value={[new PromptReference(uri)]} />
            )}
            {uri.fsPath}:<br />
            ``` <br />
            Unable to read resource: {msg}
            <br />
            ```
            <br />
          </Tag>
        );
      }
    } else if (value instanceof vscode.Location) {
      let uri = value.uri;
      if (!uri.scheme && this.props.workspaceFolder) {
        const raw = uri.fsPath || "";
        const logger = Logger.getInstance();
        try {
          const norm = normalizeToWorkspaceFile(raw, this.props.workspaceFolder);
          uri = norm.uri;
          logger.debugPath("PromptReference-Location", raw, uri.fsPath, this.props.workspaceFolder.uri.fsPath);
        } catch (e) {
          logger.debug(`Could not normalize path ${raw}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const rangeText = (await vscode.workspace.openTextDocument(uri)).getText(
        value.range
      );
      return (
        <Tag name="context">
          {!this.props.excludeReferences && (
            <references value={[new PromptReference(value)]} />
          )}
          {uri.fsPath}:{value.range.start.line + 1}-{value.range.end.line + 1}:{" "}
          <br />
          ```
          <br />
          {rangeText}
          <br />
          ```
        </Tag>
      );
    } else if (typeof value === "string") {
      return <Tag name="context">{value}</Tag>;
    }
  }
}

type TagProps = PromptElementProps<{
  name: string;
}>;

class Tag extends PromptElement<TagProps> {
  private static readonly _regex = /^[a-zA-Z_][\w.-]*$/;

  render() {
    const { name } = this.props;
    if (!Tag._regex.test(name)) {
      throw new Error(`Invalid tag name: ${this.props.name}`);
    }
    return (
      <>
        {"<" + name + ">"}
        <br />
        <>
          {this.props.children}
          <br />
        </>
        {"</" + name + ">"}
        <br />
      </>
    );
  }
}
