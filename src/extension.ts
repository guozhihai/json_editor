import * as vscode from 'vscode';
import { JsonEditorPanel } from './editorPanel';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('config-editor.openVisualEditor', (uri?: vscode.Uri) =>
			JsonEditorPanel.open(context, uri)
		)
	);
}

export function deactivate() {}
