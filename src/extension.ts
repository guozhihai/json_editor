import * as vscode from 'vscode';
import { ConfigNode, ConfigTreeProvider } from './configTree';
import { JsonEditorPanel } from './editorPanel';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ConfigTreeProvider(context.workspaceState);
	const treeView = vscode.window.createTreeView('config-editor.configTree', {
		treeDataProvider: provider
	});
	provider.bindView(treeView);

	context.subscriptions.push(
		treeView,
		provider,
		vscode.commands.registerCommand('config-editor.openConfig', (uri?: vscode.Uri) => provider.open(uri)),
		vscode.commands.registerCommand('config-editor.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('config-editor.editValue', (node: ConfigNode) => provider.editValue(node)),
		vscode.commands.registerCommand('config-editor.chooseSchema', () => provider.chooseSchema()),
		vscode.commands.registerCommand('config-editor.openVisualEditor', (uri?: vscode.Uri) =>
			JsonEditorPanel.open(context, uri)
		)
	);
}

export function deactivate() {}
