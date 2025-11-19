import * as path from 'path';
import * as vscode from 'vscode';
import {
	ConfigSchema,
	SchemaFieldDefinition,
	SchemaRange,
	SchemaValueType,
	readSchemaFile,
	resolveAdditionalSchemaLocations,
	schemaMappingKey
} from './schema';
import { PathSegment, buildPathKey, getValueAtPath, inferSchemaType, parsePathKey, setValueAtPath } from './pathUtils';

interface PanelSession {
	uri: vscode.Uri;
	data: any;
	schema?: ConfigSchema;
}

interface PanelMessage {
	type: 'ready' | 'editValue' | 'reload' | 'selectSchema' | 'save';
	path?: string;
	value?: unknown;
	valueType?: SchemaValueType;
}

export class JsonEditorPanel implements vscode.Disposable {
	private static readonly panels = new Map<string, JsonEditorPanel>();

	static async open(context: vscode.ExtensionContext, targetUri?: vscode.Uri): Promise<void> {
		const uri = await resolveTargetUri(targetUri);
		if (!uri) {
			return;
		}

		const key = uri.toString();
		const existing = JsonEditorPanel.panels.get(key);
		if (existing) {
			existing.panel.reveal();
			await existing.loadDocument(uri, false);
			return;
		}

		const panel = new JsonEditorPanel(context, context.workspaceState, uri);
		JsonEditorPanel.panels.set(key, panel);
	}

	private panel: vscode.WebviewPanel;
	private session?: PanelSession;
	private isReady = false;
	private configWatcher?: vscode.FileSystemWatcher;
	private schemaWatcher?: vscode.FileSystemWatcher;
	private disposed = false;
	private panelDisposed = false;
	private modifiedPaths = new Set<string>();
	private originalData?: any;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly workspaceState: vscode.Memento,
		private readonly initialUri: vscode.Uri
	) {
		this.panel = vscode.window.createWebviewPanel(
			'configEditor.visualizer',
			this.getTitle(initialUri),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		this.panel.onDidDispose(() => {
			this.panelDisposed = true;
			this.dispose();
		});
		this.panel.webview.onDidReceiveMessage((message: PanelMessage) => {
			switch (message.type) {
				case 'ready':
					this.isReady = true;
					this.syncState();
					break;
				case 'reload':
					void this.refresh();
					break;
				case 'selectSchema':
					void this.chooseSchema();
					break;
				case 'save':
					void this.saveDocument();
					break;
				case 'editValue':
					if (message.path && message.valueType !== undefined) {
						void this.updateValue(message.path, message.value, message.valueType);
					}
					break;
				default:
					break;
			}
		});

		this.panel.webview.html = this.getHtml();
		void this.loadDocument(initialUri, true);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.configWatcher?.dispose();
		this.schemaWatcher?.dispose();
		if (!this.panelDisposed) {
			this.panelDisposed = true;
			this.panel.dispose();
		}

		JsonEditorPanel.panels.delete(this.initialUri.toString());
	}

	private async refresh(): Promise<void> {
		if (!this.session) {
			return;
		}

		await this.loadDocument(this.session.uri, true);
	}

	private async saveDocument(): Promise<void> {
		if (!this.session) {
			return;
		}

		try {
			await this.persistChanges();
			this.originalData = JSON.parse(JSON.stringify(this.session.data));
			this.modifiedPaths.clear();
			this.syncState();
			this.postStatus('info', 'Config saved.');
		} catch (error) {
			this.postStatus('error', `Failed to save config: ${getErrorMessage(error)}`);
		}
	}

	private async chooseSchema(): Promise<void> {
		if (!this.session) {
			return;
		}

		const pick = await vscode.window.showQuickPick(
			[
				{ label: 'Browse for schema file…', value: 'pick' },
				{ label: 'Use automatic detection', value: 'auto' }
			],
			{ placeHolder: 'Schema options' }
		);

		if (!pick) {
			return;
		}

		const stateKey = schemaMappingKey(this.session.uri.fsPath);
		if (pick.value === 'auto') {
			await this.workspaceState.update(stateKey, undefined);
			await this.refresh();
			this.postStatus('info', 'Schema mapping cleared. Automatic detection restored.');
			return;
		}

		const selection = await vscode.window.showOpenDialog({
			defaultUri: this.session.uri,
			canSelectMany: false,
			openLabel: 'Select schema JSON',
			filters: { JSON: ['json'] }
		});

		if (!selection || selection.length === 0) {
			return;
		}

		await this.workspaceState.update(stateKey, selection[0].fsPath);
		await this.refresh();
		this.postStatus('info', 'Schema attached to current config.');
	}

	private async updateValue(pathKey: string, rawValue: unknown, valueType: SchemaValueType): Promise<void> {
		if (!this.session) {
			return;
		}

		const segments = parsePathKey(pathKey);
		const schemaEntry = this.session.schema?.getField(pathKey);
		const typedValue = this.castValue(rawValue, valueType);
		if (typedValue === undefined) {
			this.postStatus('error', 'Invalid value.');
			return;
		}

		if (!this.validateValue(typedValue, schemaEntry)) {
			this.postStatus('error', 'Value is outside the allowed range.');
			return;
		}

		let success = false;
		if (segments.length === 0) {
			this.session.data = typedValue;
			success = true;
		} else {
			success = setValueAtPath(this.session.data, segments, typedValue);
		}
		if (!success) {
			this.postStatus('error', 'Failed to update value.');
			return;
		}

		const baselineValue = this.originalData
			? segments.length === 0
				? this.originalData
				: getValueAtPath(this.originalData, segments)
			: undefined;
		const reverted = arePrimitiveEqual(typedValue, baselineValue);

		if (reverted) {
			this.modifiedPaths.delete(pathKey);
		} else {
			this.modifiedPaths.add(pathKey);
		}

		this.syncState();
		this.postStatus('info', 'Value updated (unsaved).');
	}

	private castValue(value: unknown, type: SchemaValueType): unknown {
		if (value === null || value === undefined) {
			return undefined;
		}

		if (type === 'integer') {
			const parsed = Number.parseInt(String(value), 10);
			return Number.isNaN(parsed) ? undefined : parsed;
		}

		if (type === 'number') {
			const parsed = Number.parseFloat(String(value));
			return Number.isNaN(parsed) ? undefined : parsed;
		}

		if (type === 'boolean') {
			if (typeof value === 'boolean') {
				return value;
			}

			const lowered = String(value).toLowerCase();
			if (lowered === 'true') {
				return true;
			}

			if (lowered === 'false') {
				return false;
			}

			return undefined;
		}

		return String(value);
	}

	private validateValue(value: unknown, schemaEntry?: SchemaFieldDefinition): boolean {
		if (!schemaEntry) {
			return true;
		}

		if (schemaEntry.enum && schemaEntry.enum.length > 0) {
			return schemaEntry.enum.some((entry) => entry === value);
		}

		const range = schemaEntry.range;
		if (!range || typeof value !== 'number') {
			return true;
		}

		if (typeof range.min === 'number' && value < range.min) {
			return false;
		}

		if (typeof range.max === 'number' && value > range.max) {
			return false;
		}

		return true;
	}

	private async loadDocument(uri: vscode.Uri, notify: boolean): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');
			const parsed = JSON.parse(text);
			const schema = await this.loadSchema(uri);
			this.session = { uri, data: parsed, schema };
			this.originalData = JSON.parse(text);
			this.modifiedPaths.clear();
			this.panel.title = this.getTitle(uri);
			this.watchConfig(uri);
			this.watchSchema(schema);
			this.syncState();
			if (notify) {
				const suffix = schema ? ` with schema ${path.basename(schema.uri.fsPath)}` : '';
				this.postStatus('info', `Loaded ${path.basename(uri.fsPath)}${suffix}.`);
			}
		} catch (error) {
			this.postStatus('error', `Failed to load config: ${getErrorMessage(error)}`);
		}
	}

	private async loadSchema(configUri: vscode.Uri): Promise<ConfigSchema | undefined> {
		const configuration = vscode.workspace.getConfiguration('configEditor');
		const suffix = configuration.get<string>('schemaSuffix', '_Schema');
		const pathInfo = path.parse(configUri.fsPath);
		const extension = pathInfo.ext || '.json';
		const defaultSchemaPath = path.join(pathInfo.dir, `${pathInfo.name}${suffix}${extension}`);
		const stored = this.workspaceState.get<string>(schemaMappingKey(configUri.fsPath));

		const candidates: vscode.Uri[] = [];
		if (stored) {
			candidates.push(vscode.Uri.file(stored));
		}

		candidates.push(vscode.Uri.file(defaultSchemaPath));

		for (const location of resolveAdditionalSchemaLocations()) {
			const candidate = vscode.Uri.file(path.join(location.fsPath, `${pathInfo.name}${suffix}${extension}`));
			candidates.push(candidate);
		}

		const seen = new Set<string>();
		for (const candidate of candidates) {
			const key = candidate.fsPath;
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			const schema = await readSchemaFile(candidate);
			if (schema) {
				return schema;
			}
		}

		return undefined;
	}

	private watchConfig(uri: vscode.Uri): void {
		this.configWatcher?.dispose();
		const pattern = new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath));
		this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		const reload = () => void this.refresh();
		this.configWatcher.onDidChange(reload);
		this.configWatcher.onDidCreate(reload);
		this.configWatcher.onDidDelete(() => {
			this.session = undefined;
			this.postStatus('error', 'Config file was deleted.');
		});
	}

	private watchSchema(schema?: ConfigSchema): void {
		this.schemaWatcher?.dispose();
		if (!schema) {
			return;
		}

		const pattern = new vscode.RelativePattern(path.dirname(schema.uri.fsPath), path.basename(schema.uri.fsPath));
		this.schemaWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		const reload = async () => {
			if (!this.session) {
				return;
			}

			this.session.schema = await this.loadSchema(this.session.uri);
			this.syncState();
		};

		this.schemaWatcher.onDidChange(reload);
		this.schemaWatcher.onDidCreate(reload);
		this.schemaWatcher.onDidDelete(() => {
			if (!this.session) {
				return;
			}

			this.session.schema = undefined;
			this.syncState();
		});
	}

	private async persistChanges(): Promise<void> {
		if (!this.session) {
			return;
		}

		const configuration = vscode.workspace.getConfiguration('configEditor');
		const indent = Math.max(0, configuration.get<number>('indentSize', 2));
		const text = JSON.stringify(this.session.data, null, indent) + '\n';
		const document = await vscode.workspace.openTextDocument(this.session.uri);
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(this.session.uri, fullRange, text);
		await vscode.workspace.applyEdit(edit);
		await document.save();
	}

	private syncState(): void {
		if (!this.session || !this.isReady) {
			return;
		}

		this.panel.webview.postMessage({
			type: 'init',
			payload: {
				fileName: path.basename(this.session.uri.fsPath),
				filePath: this.session.uri.fsPath,
				data: this.session.data,
				schemaFile: this.session.schema?.uri.fsPath,
				schema: this.session.schema?.getAll() ?? {},
				modifiedPaths: Array.from(this.modifiedPaths)
			}
		});
	}

	private postStatus(level: 'info' | 'error', message: string): void {
		if (this.isReady) {
			this.panel.webview.postMessage({ type: 'status', level, message });
		} else {
			if (level === 'info') {
				void vscode.window.showInformationMessage(message);
			} else {
				void vscode.window.showErrorMessage(message);
			}
		}
	}

	private getTitle(uri: vscode.Uri): string {
		return `Config Editor: ${path.basename(uri.fsPath)}`;
	}

	private getHtml(): string {
		const nonce = String(Date.now());
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Config Editor</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			margin: 0;
			padding: 0;
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.5rem 1rem;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.toolbar input[type="text"] {
			flex: 1;
			padding: 0.3rem 0.4rem;
			border: 1px solid var(--vscode-input-border, #555);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
		}
		.toolbar button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 0.3rem 0.8rem;
			cursor: pointer;
		}
		.toolbar button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.layout {
			flex: 1;
			display: grid;
			grid-template-columns: 1fr 320px;
			min-height: 0;
		}
		.tree-container {
			padding: 0.5rem 1rem;
			overflow: auto;
			border-right: 1px solid var(--vscode-panel-border);
		}
		.details {
			padding: 0.75rem 1rem;
			overflow: auto;
		}
		.tree ul {
			list-style: none;
			padding-left: 1rem;
			margin: 0;
		}
		.tree li {
			margin: 0.1rem 0;
		}
		.node-header {
			display: flex;
			align-items: center;
			gap: 0.3rem;
		}
		.toggle {
			width: 1.5rem;
			height: 1.5rem;
			border: none;
			background: transparent;
			cursor: pointer;
			color: inherit;
		}
		.toggle.spacer {
			cursor: default;
		}
		.tree .node-label {
			cursor: pointer;
			border: none;
			background: transparent;
			color: inherit;
			width: 100%;
			text-align: left;
			padding: 0.1rem 0.2rem;
			border-radius: 4px;
			position: relative;
		}
		.tree .node-label:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.tree .node-label.selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
		.tree .node-label.dim {
			opacity: 0.5;
		}
		.tree .node-label.modified {
			padding-left: 0.4rem;
			font-weight: bold;
			color: var(--vscode-terminal-ansiRed, #ff5f5f);
		}
		.tree .node-label.modified::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 0.2rem;
			border-radius: 2px;
			background: var(--vscode-testing-coveredIcon, #ff5f5f);
		}
		.detail-row {
			margin-bottom: 0.8rem;
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}
		.detail-row label {
			font-size: 0.85rem;
			color: var(--vscode-descriptionForeground);
		}
		.detail-row input,
		.detail-row select,
		.detail-row textarea {
			width: 100%;
			padding: 0.3rem 0.4rem;
			border: 1px solid var(--vscode-input-border, #555);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font: inherit;
		}
		.detail-row textarea {
			min-height: 3rem;
		}
		.detail-row input.no-spinner::-webkit-outer-spin-button,
		.detail-row input.no-spinner::-webkit-inner-spin-button {
			-webkit-appearance: none;
			margin: 0;
		}
		.detail-row input.no-spinner {
			-moz-appearance: textfield;
		}
		.status {
			font-size: 0.85rem;
			margin-top: 0.5rem;
			min-height: 1.5rem;
		}
		.status.error {
			color: var(--vscode-errorForeground);
		}
		.status.info {
			color: var(--vscode-descriptionForeground);
		}
		.empty-state {
			color: var(--vscode-descriptionForeground);
			padding: 1rem;
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<input id="searchBox" type="text" placeholder="Search key or value…" />
		<button id="reloadBtn" title="Reload file">Reload</button>
		<button id="saveFileBtn" title="Save changes to disk">Save</button>
		<button id="schemaBtn" title="Select schema file">Select Schema</button>
	</div>
	<div class="layout">
		<div class="tree-container">
			<div id="tree" class="tree empty-state">No config loaded.</div>
		</div>
		<div class="details">
			<div class="detail-row">
				<label>Selected Key</label>
				<div id="selectedKey">Select a node from the tree.</div>
			</div>
			<div id="valueEditor" style="display:none;">
				<div class="detail-row">
					<label id="valueLabel">Value</label>
					<div id="valueControls"></div>
				</div>
				<div class="detail-row">
					<label>Description</label>
					<div id="valueDescription">-</div>
				</div>
				<div class="detail-row" id="rangeRow" style="display:none;">
					<label>Range</label>
					<div id="rangeText">-</div>
				</div>
			</div>
			<div id="status" class="status"></div>
		</div>
	</div>
	<script nonce="${nonce}">
		(function(){
			const vscode = acquireVsCodeApi();
			const treeContainer = document.getElementById('tree');
			const searchBox = document.getElementById('searchBox');
			const selectedKey = document.getElementById('selectedKey');
			const valueEditor = document.getElementById('valueEditor');
			const valueControls = document.getElementById('valueControls');
			const valueDescription = document.getElementById('valueDescription');
			const rangeRow = document.getElementById('rangeRow');
			const rangeText = document.getElementById('rangeText');
			const statusNode = document.getElementById('status');
			const saveFileBtn = document.getElementById('saveFileBtn');
			let data = undefined;
			let schema = {};
			let currentSelection = null;
			let modifiedPaths = new Set();
			const branchControls = new Map();
			const collapsedPaths = new Set();

			document.getElementById('reloadBtn').addEventListener('click', () => {
				vscode.postMessage({ type: 'reload' });
			});
			document.getElementById('schemaBtn').addEventListener('click', () => {
				vscode.postMessage({ type: 'selectSchema' });
			});
			saveFileBtn.addEventListener('click', () => {
				if (saveFileBtn.disabled) {
					return;
				}
				vscode.postMessage({ type: 'save' });
			});

			searchBox.addEventListener('input', () => {
				renderTree(searchBox.value);
			});

			window.addEventListener('message', (event) => {
				const msg = event.data;
				if (msg.type === 'init') {
					data = msg.payload.data;
					schema = msg.payload.schema || {};
					modifiedPaths = new Set(msg.payload.modifiedPaths || []);
					saveFileBtn.disabled = modifiedPaths.size === 0;
					renderTree(searchBox.value);
					if (currentSelection) {
						selectPath(currentSelection.pathKey);
					}
				} else if (msg.type === 'status') {
					statusNode.textContent = msg.message;
					statusNode.className = 'status ' + msg.level;
				}
			});

			vscode.postMessage({ type: 'ready' });
			treeContainer.addEventListener('keydown', handleTreeNavigation);

			function renderTree(filterText) {
				branchControls.clear();
				if (!data) {
					treeContainer.textContent = 'No config loaded.';
					treeContainer.classList.add('empty-state');
					return;
				}

				const filter = (filterText || '').toLowerCase();
				treeContainer.innerHTML = '';
				treeContainer.classList.remove('empty-state');
				const root = document.createElement('ul');
				buildNodes(data, [], root, filter);
				treeContainer.appendChild(root);
				if (currentSelection) {
					highlightSelection(currentSelection.pathKey);
				}
			}

			function buildNodes(value, segments, parent, filter) {
				if (Array.isArray(value)) {
					value.forEach((entry, index) => {
						const childSegments = [...segments, index];
						const pathKey = buildPathKey(childSegments);
						if (!isVisibleNode(pathKey)) {
							return;
						}
						appendNode('[' + index + ']', entry, childSegments, parent, filter, pathKey);
					});
					return;
				}

				if (value && typeof value === 'object') {
					Object.keys(value).forEach((key) => {
						const childSegments = [...segments, key];
						const pathKey = buildPathKey(childSegments);
						if (!isVisibleNode(pathKey)) {
							return;
						}
						appendNode(key, value[key], childSegments, parent, filter, pathKey);
					});
				}
			}

			function registerBranchControl(pathKey, toggle, nestedList) {
				const entry = { toggle, list: nestedList };
				const key = pathKey || '';
				branchControls.set(key, entry);
				const collapsed = collapsedPaths.has(key);
				applyBranchState(entry, collapsed, key);
				return entry;
			}

			function applyBranchState(entry, collapsed, pathKey) {
				entry.list.style.display = collapsed ? 'none' : '';
				entry.list.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
				entry.toggle.textContent = collapsed ? '⊞' : '⊟';
				if (pathKey !== undefined) {
					if (collapsed) {
						collapsedPaths.add(pathKey);
					} else {
						collapsedPaths.delete(pathKey);
					}
				}
			}

			function setBranchCollapsed(pathKey, collapsed) {
				const entry = branchControls.get(pathKey || '');
				if (!entry) {
					return false;
				}
				const isCollapsed = entry.list.getAttribute('data-collapsed') === 'true';
				if (isCollapsed === collapsed) {
					return false;
				}
				applyBranchState(entry, collapsed, pathKey || '');
				return true;
			}

			function toggleBranchState(pathKey) {
				const entry = branchControls.get(pathKey || '');
				if (!entry) {
					return;
				}
				const isCollapsed = entry.list.getAttribute('data-collapsed') === 'true';
				applyBranchState(entry, !isCollapsed, pathKey || '');
			}

			function isBranchNode(button) {
				return button?.dataset?.branch === 'true';
			}

			function isNodeVisible(button) {
				if (!button) {
					return false;
				}
				return !button.closest('ul[data-collapsed="true"]');
			}

			function focusSiblingNode(button, offset) {
				const buttons = Array.from(treeContainer.querySelectorAll('.node-label')).filter((node) =>
					isNodeVisible(node)
				);
				const index = buttons.indexOf(button);
				if (index === -1) {
					return;
				}
				const targetIndex = index + offset;
				if (targetIndex < 0 || targetIndex >= buttons.length) {
					return;
				}
				const target = buttons[targetIndex];
				if (target) {
					target.focus();
					target.click();
				}
			}

			function findParentNodeButton(button) {
				const currentLi = button.closest('li');
				if (!currentLi) {
					return null;
				}
				const parentList = currentLi.parentElement;
				if (!parentList) {
					return null;
				}
				const parentLi = parentList.closest('li');
				if (!parentLi) {
					return null;
				}
				const header = parentLi.querySelector('.node-header');
				if (!header) {
					return null;
				}
				return header.querySelector('.node-label');
			}

			function handleTreeNavigation(event) {
				if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
					return;
				}
				const activeElement = document.activeElement;
				if (!activeElement || !activeElement.classList || !activeElement.classList.contains('node-label')) {
					return;
				}
				if (!treeContainer.contains(activeElement)) {
					return;
				}
				const pathKey = activeElement.dataset.path || '';
				const branch = isBranchNode(activeElement);
				switch (event.key) {
					case 'ArrowLeft': {
						event.preventDefault();
						if (branch && setBranchCollapsed(pathKey, true)) {
							return;
						}
						const parentButton = findParentNodeButton(activeElement);
						if (parentButton) {
							parentButton.focus();
							parentButton.click();
						}
						break;
					}
					case 'ArrowRight': {
						if (branch) {
							const expanded = setBranchCollapsed(pathKey, false);
							if (expanded) {
								event.preventDefault();
							}
						}
						break;
					}
					case 'ArrowUp':
						event.preventDefault();
						focusSiblingNode(activeElement, -1);
						break;
					case 'ArrowDown':
						event.preventDefault();
						focusSiblingNode(activeElement, 1);
						break;
					case 'Enter': {
						if (branch) {
							if (setBranchCollapsed(pathKey, false)) {
								event.preventDefault();
							}
						} else {
							event.preventDefault();
							activeElement.click();
							const editor = valueControls.querySelector('[data-editor=\"value\"]');
							if (editor) {
								editor.focus();
							}
						}
						break;
					}
					default:
						break;
				}
			}

			function appendNode(label, value, segments, parent, filter, pathKey) {
				const li = document.createElement('li');
				const header = document.createElement('div');
				header.className = 'node-header';
				const isBranch = isContainer(value);
				let nestedList;

				if (isBranch) {
					const toggle = document.createElement('button');
					toggle.className = 'toggle';
					toggle.type = 'button';
					toggle.textContent = '⊟';
					header.appendChild(toggle);
					nestedList = document.createElement('ul');
					registerBranchControl(pathKey, toggle, nestedList);
					toggle.addEventListener('click', (event) => {
						event.stopPropagation();
						toggleBranchState(pathKey);
					});
				} else {
					const spacer = document.createElement('span');
					spacer.className = 'toggle spacer';
					header.appendChild(spacer);
				}

				const button = createNodeButton(label, value, pathKey, filter, isBranch);
				header.appendChild(button);
				li.appendChild(header);

				if (isBranch && nestedList) {
					li.appendChild(nestedList);
					buildNodes(value, segments, nestedList, filter);
				}

				parent.appendChild(li);
			}

			function createNodeButton(key, value, pathKey, filter, isBranch) {
				const button = document.createElement('button');
				button.className = 'node-label';
				button.type = 'button';
				button.dataset.path = pathKey || '';
				button.dataset.branch = String(isBranch);
				const textValue = isBranch ? '' : formatValue(value);
				const combined = (key + ' ' + textValue).toLowerCase();
				if (filter && !combined.includes(filter)) {
					button.classList.add('dim');
				}
				button.textContent = !isBranch && textValue ? key + ': ' + textValue : key;
				button.addEventListener('click', () => {
					selectNode(pathKey, value, key);
					updateSelection(button);
				});
				if (currentSelection && currentSelection.pathKey === pathKey) {
					button.classList.add('selected');
				}
				if (modifiedPaths.has(pathKey || '')) {
					button.classList.add('modified');
				}
				return button;
			}

			function updateSelection(button) {
				treeContainer.querySelectorAll('.node-label.selected').forEach((node) => node.classList.remove('selected'));
				if (button) {
					button.classList.add('selected');
				}
			}

			function highlightSelection(pathKey) {
				const selectorPath = pathKey || '';
				const button = treeContainer.querySelector('.node-label[data-path="' + selectorPath.replace(/"/g, '\\"') + '"]');
				if (button) {
					updateSelection(button);
				}
			}

			function selectNode(pathKey, value, key) {
				currentSelection = { pathKey, key, value };
				selectedKey.textContent = pathKey || '(root)';
				renderValueEditor(value, pathKey);
			}

			function selectPath(pathKey) {
				const segments = parsePathKey(pathKey);
				let current = data;
				for (const segment of segments) {
					if (current === undefined || current === null) {
						return;
					}
					current = typeof segment === 'number' ? current[segment] : current[segment];
				}
				if (current !== undefined) {
					const key = segments.length > 0 ? segments[segments.length - 1] : '';
					currentSelection = { pathKey, key, value: current };
					selectedKey.textContent = pathKey || '(root)';
					renderValueEditor(current, pathKey);
					highlightSelection(pathKey);
				}
			}

			function renderValueEditor(value, pathKey) {
				if (value && typeof value === 'object') {
					valueEditor.style.display = 'none';
					selectedKey.textContent = pathKey || '(root)';
					return;
				}

				const schemaEntry = schema[pathKey] || {};
				const type = schemaEntry.type || inferType(value);
				valueEditor.style.display = 'block';
				valueDescription.textContent = schemaEntry.description || '-';
				const showRange = schemaEntry.range && shouldDisplayRange(schemaEntry, type);
				if (showRange) {
					rangeRow.style.display = 'block';
					rangeText.textContent = formatRange(schemaEntry.range);
				} else {
					rangeRow.style.display = 'none';
				}
				valueControls.innerHTML = '';
				let editor;
				const options = schemaEntry.enum || (schemaEntry.range && schemaEntry.range.options);
				if (options && options.length > 0) {
					editor = document.createElement('select');
					options.forEach((opt) => {
						const option = document.createElement('option');
						option.value = String(opt);
						option.textContent = String(opt);
						if (String(opt) === String(value)) {
							option.selected = true;
						}
						editor.appendChild(option);
					});
				} else if (type === 'boolean') {
					editor = document.createElement('select');
					['true', 'false'].forEach((opt) => {
						const option = document.createElement('option');
						option.value = opt;
						option.textContent = opt;
						if (String(value).toLowerCase() === opt) {
							option.selected = true;
						}
						editor.appendChild(option);
					});
				} else {
					editor = document.createElement('input');
					const isNumeric = type === 'number' || type === 'integer';
					const isFloatSchemaType = isNumeric && schemaEntry.rawType === 'float';
					editor.type = isNumeric ? 'number' : 'text';
					if (isFloatSchemaType) {
						editor.classList.add('no-spinner');
						editor.step = 'any';
						editor.inputMode = 'decimal';
					}
					editor.value = value === undefined || value === null ? '' : String(value);
					if (type === 'integer') {
						editor.step = '1';
					}
				}

				editor.setAttribute('data-editor', 'value');
				editor.setAttribute('data-type', type);

				if (schemaEntry.range && schemaEntry.range.min !== undefined) {
					editor.min = schemaEntry.range.min;
				}
				if (schemaEntry.range && schemaEntry.range.max !== undefined) {
					editor.max = schemaEntry.range.max;
				}

				valueControls.appendChild(editor);
				setupEditorCommit(editor, pathKey, type);
			}

			function formatValue(value) {
				if (value === null) {
					return 'null';
				}
				if (typeof value === 'object') {
					return Array.isArray(value) ? '[...]' : '{...}';
				}
				return String(value);
			}

			function isContainer(value) {
				return value && typeof value === 'object';
			}

			function buildPathKey(segments) {
				if (!segments || segments.length === 0) {
					return '';
				}
				return segments
					.map((segment, index) => {
						if (typeof segment === 'number') {
							return '[' + segment + ']';
						}
						return index === 0 ? segment : '.' + segment;
					})
					.join('');
			}

			function parsePathKey(pathKey) {
				if (!pathKey) {
					return [];
				}
				const tokens = pathKey.match(/[^.[\]]+|\[\d+\]/g);
				if (!tokens) {
					return [];
				}
				return tokens.map((token) => {
					if (token.startsWith('[') && token.endsWith(']')) {
						return Number.parseInt(token.slice(1, -1), 10);
					}
					return token;
				});
			}

			function inferType(value) {
				if (typeof value === 'number') {
					return Number.isInteger(value) ? 'integer' : 'number';
				}
				if (typeof value === 'boolean') {
					return 'boolean';
				}
				return 'string';
			}

			function isVisibleNode(pathKey) {
				const entry = schema[pathKey];
				if (!entry) {
					return true;
				}
				return entry.visible !== false;
			}

			function shouldDisplayRange(schemaEntry, type) {
				if (!schemaEntry.range) {
					return false;
				}
				if (schemaEntry.enum && schemaEntry.enum.length > 0) {
					return false;
				}
				if (schemaEntry.range.options && schemaEntry.range.options.length > 0) {
					return type !== 'enum';
				}
				return typeof schemaEntry.range.min === 'number' || typeof schemaEntry.range.max === 'number';
			}

			function formatRange(range) {
				if (range.options && range.options.length > 0) {
					return range.options.join(', ');
				}
				const parts = [];
				if (typeof range.min === 'number' && typeof range.max === 'number') {
					parts.push(String(range.min) + ' - ' + String(range.max));
				} else if (typeof range.min === 'number') {
					parts.push('>= ' + String(range.min));
				} else if (typeof range.max === 'number') {
					parts.push('<= ' + String(range.max));
				}
				return parts.join(' ') || '-';
			}

			function setStatusError(message) {
				statusNode.textContent = message;
				statusNode.className = 'status error';
			}

			function setupEditorCommit(editor, pathKey, type, schemaEntry) {
				const commit = () => {
					if (!pathKey) {
						return;
					}
					let value = editor.value;
					if (type === 'boolean') {
						value = editor.value === 'true';
					} else if (type === 'number' || type === 'integer') {
						value = editor.value;
						const parsed = Number.parseFloat(String(value));
						if (Number.isNaN(parsed)) {
							setStatusError('Enter a valid number.');
							return;
						}
						if (schemaEntry && schemaEntry.range) {
							const { min, max } = schemaEntry.range;
							if (typeof min === 'number' && parsed < min) {
								setStatusError('Value must be >= ' + min + '.');
								return;
							}
							if (typeof max === 'number' && parsed > max) {
								setStatusError('Value must be <= ' + max + '.');
								return;
							}
						}
					}
					vscode.postMessage({ type: 'editValue', path: pathKey, valueType: type, value });
				};

				if (editor.tagName === 'SELECT') {
					editor.addEventListener('change', commit);
				} else {
					editor.addEventListener('change', commit);
					editor.addEventListener('blur', commit);
					editor.addEventListener('keydown', (event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							commit();
						}
					});
				}
			}
		})();
	</script>
</body>
</html>`;
	}
}

async function resolveTargetUri(targetUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (targetUri) {
		return targetUri;
	}

	const active = vscode.window.activeTextEditor?.document;
	if (active && isJsonDocument(active)) {
		return active.uri;
	}

	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Open Config File'
	});

	return picked?.[0];
}

function isJsonDocument(document: vscode.TextDocument): boolean {
	return ['json', 'jsonc'].includes(document.languageId.toLowerCase());
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function arePrimitiveEqual(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number') {
		return Number.isNaN(a) && Number.isNaN(b) ? true : a === b;
	}

	return a === b;
}
