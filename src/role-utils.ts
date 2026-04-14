import { LanguageModelChatMessageRole } from 'vscode';

/**
 * Convert VS Code message role to Z role
 */
export function toZRole(role: LanguageModelChatMessageRole): 'user' | 'assistant' {
  switch (role) {
    case LanguageModelChatMessageRole.User:
      return 'user';
    case LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    default:
      return 'user';
  }
}
