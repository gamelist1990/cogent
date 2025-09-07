import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './Logger';

export interface NormalizedPathResult {
  fsPath: string;
  uri: vscode.Uri;
  insideWorkspace: boolean;
}

/**
 * Normalize various incoming path patterns into a consistent absolute file system path
 * and corresponding vscode.Uri. Rules:
 * - If the input is already an absolute path (Windows drive or POSIX), normalize and return it.
 * - If the input is a relative path, resolve it against the provided workspace folder.
 * - If the input begins with a leading slash but not a windows drive, treat as relative (strip leading slashes) and resolve against workspace.
 */
export function normalizeToWorkspaceFile(inputPath: string, workspaceFolder?: vscode.WorkspaceFolder): NormalizedPathResult {
  const raw = (inputPath ?? '').toString().trim();
  if (!raw) throw new Error('Empty path');

  Logger.getInstance().debug(`[normalizeToWorkspaceFile] Input: "${raw}"`);

  // Detect Windows drive absolute (e.g. C:\foo or C:/foo)
  const isWindowsDrive = /^[a-zA-Z]:[\\\/]/.test(raw);

  // If path looks like POSIX absolute (/foo) but the user probably intended workspace-relative
  let cleaned = raw;
  if (cleaned.startsWith('/') && !isWindowsDrive) {
    // strip leading slashes to treat as workspace-relative
    cleaned = cleaned.replace(/^\/+/, '');
    Logger.getInstance().debug(`[normalizeToWorkspaceFile] Stripped leading slashes: "${cleaned}"`);
  }

  const isAbsolute = path.isAbsolute(cleaned) || isWindowsDrive;
  Logger.getInstance().debug(`[normalizeToWorkspaceFile] isAbsolute: ${isAbsolute}, isWindowsDrive: ${isWindowsDrive}`);

  let fsPath: string;
  if (isAbsolute) {
    fsPath = path.normalize(cleaned);
    Logger.getInstance().debug(`[normalizeToWorkspaceFile] Absolute path normalized: "${fsPath}"`);
  } else {
    if (!workspaceFolder) throw new Error('No workspace folder to resolve relative path');
    fsPath = path.normalize(path.resolve(workspaceFolder.uri.fsPath, cleaned));
    Logger.getInstance().debug(`[normalizeToWorkspaceFile] Relative path resolved: "${fsPath}"`);
  }

  const insideWorkspace = !!workspaceFolder && 
    fsPath.toLowerCase().startsWith(workspaceFolder.uri.fsPath.toLowerCase()) &&
    !path.relative(workspaceFolder.uri.fsPath, fsPath).startsWith('..');
  Logger.getInstance().debug(`[normalizeToWorkspaceFile] insideWorkspace: ${insideWorkspace}, workspace: ${workspaceFolder?.uri.fsPath}`);
  Logger.getInstance().debug(`[normalizeToWorkspaceFile] relative path: ${workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, fsPath) : 'N/A'}`);
  Logger.getInstance().debug(`[normalizeToWorkspaceFile] startsWith check: ${workspaceFolder ? fsPath.toLowerCase().startsWith(workspaceFolder.uri.fsPath.toLowerCase()) : 'N/A'}`);

  return { fsPath, uri: vscode.Uri.file(fsPath), insideWorkspace };
}

/** 指定されたパスがワークスペース内に存在するか検証し、外ならエラーを投げる */
export function requireInsideWorkspace(result: NormalizedPathResult) {
  if (!result.insideWorkspace) {
    throw new Error('Path is outside of the current workspace root');
  }
}

/** 任意の文字列パスを受け取りワークスペース内ならNormalizedPathResultを返し、外なら undefined */
export function tryNormalizeIfInside(inputPath: string, workspaceFolder?: vscode.WorkspaceFolder): NormalizedPathResult | undefined {
  try {
    Logger.getInstance().debug(`[tryNormalizeIfInside] Input: "${inputPath}"`);
    const norm = normalizeToWorkspaceFile(inputPath, workspaceFolder);
    Logger.getInstance().debug(`[tryNormalizeIfInside] Result: insideWorkspace=${norm.insideWorkspace}, fsPath="${norm.fsPath}"`);
    return norm.insideWorkspace ? norm : undefined;
  } catch (e) {
    Logger.getInstance().debug(`[tryNormalizeIfInside] Error: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * オブジェクト/配列内のパスらしきフィールド(path,filePath,file,filename,files,paths)を再帰的に正規化し、
 * ワークスペース内であれば絶対パスへ置換する。外部であれば元値をそのまま残す（拒否は呼び出し側で実施）。
 * 文字列単体が渡された場合はそのまま返す。
 */
export function deepNormalizePathFields<T>(value: T, workspaceFolder?: vscode.WorkspaceFolder): T {
  const pathKeys = new Set(['path','filePath','file','filename']);
  const arrayKeys = new Set(['files','paths']);

  const visit = (v: any): any => {
    if (v == null) return v;
    if (typeof v === 'string') {
      // 単独の文字列はここでは変換しない（フィールド名に基づく変換のみ）
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(visit);
    }
    if (typeof v === 'object') {
      const out: any = Array.isArray(v) ? [] : {};
      for (const key of Object.keys(v)) {
        const val = v[key];
        if (typeof val === 'string' && pathKeys.has(key)) {
          try {
            Logger.getInstance().debug(`[deepNormalizePathFields] Processing ${key}=${val}`);
            const norm = normalizeToWorkspaceFile(val, workspaceFolder);
            if (norm.insideWorkspace) {
              Logger.getInstance().debug(`[deepNormalizePathFields] ${key}: ${val} -> ${norm.fsPath} (inside workspace)`);
              out[key] = norm.fsPath; // 絶対パスへ
            } else {
              Logger.getInstance().debug(`[deepNormalizePathFields] ${key}: ${val} -> unchanged (outside workspace)`);
              out[key] = val; // 外部はそのまま
            }
          } catch (e) {
            Logger.getInstance().debug(`[deepNormalizePathFields] ${key}: ${val} -> unchanged (error: ${e instanceof Error ? e.message : String(e)})`);
            out[key] = val;
          }
        } else if (Array.isArray(val) && arrayKeys.has(key)) {
          out[key] = val.map(item => {
            if (typeof item === 'string') {
              try {
                const norm = normalizeToWorkspaceFile(item, workspaceFolder);
                return norm.insideWorkspace ? norm.fsPath : item;
              } catch { return item; }
            }
            return visit(item);
          });
        } else if (typeof val === 'object') {
          out[key] = visit(val);
        } else {
          out[key] = val;
        }
      }
      return out;
    }
    return v;
  };

  return visit(value);
}

export default normalizeToWorkspaceFile;
