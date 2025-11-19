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
import { PathSegment, buildPathKey, inferSchemaType, setValueAtPath } from './pathUtils';

interface ConfigSession {
	uri: vscode.Uri;
	data: unknown;
	schema?: ConfigSchema;
}

interface EditOptions {
	range?: SchemaRange;
	type: SchemaValueType;
	enumValues?: Array<string | number>;
}

export class ConfigNode extends vscode.TreeItem {
	constructor(
		public readonly key: string,
		public readonly value: unknown,
		public readonly segments: PathSegment[],
		options: {
			label: string;
			description?: string;
			collapsibleState: vscode.TreeItemCollapsibleState;
			contextValue: string;
			schema?: SchemaFieldDefinition;
			tooltip?: string;
		}
	) {
		super(options.label, options.collapsibleState);
		this.description = options.description;
		this.contextValue = options.contextValue;
		this.tooltip = options.tooltip;
		this.schema = options.schema;
	}

	readonly schema?: SchemaFieldDefinition;
}

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigNode>, vscode.Disposable {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ConfigNode | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	private session?: ConfigSession;
	private treeView?: vscode.TreeView<ConfigNode>;
	private configWatcher?: vscode.FileSystemWatcher;
	private schemaWatcher?: vscode.FileSystemWatcher;

	constructor(private readonly workspaceState: vscode.Memento) {}

	bindView(view: vscode.TreeView<ConfigNode>): void {
		this.treeView = view;
	}

	dispose(): void {
		this.configWatcher?.dispose();
		this.schemaWatcher?.dispose();
		this.onDidChangeTreeDataEmitter.dispose();
	}

	getTreeItem(element: ConfigNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ConfigNode): vscode.ProviderResult<ConfigNode[]> {
		if (!this.session) {
			if (this.treeView) {
				this.treeView.message = 'Select a JSON config file with the "Open Config (Tree)" command.';
			}

			return [];
		}

		const schemaLabel = this.session.schema
			? `Schema: ${path.basename(this.session.schema.uri.fsPath)}`
			: 'Schema: not attached';
		if (this.treeView) {
			this.treeView.message = `${schemaLabel}\nFile: ${path.basename(this.session.uri.fsPath)}`;
		}

		if (!element) {
			return this.buildChildren(this.session.data, []);
		}

		return this.buildChildren(element.value, element.segments);
	}

	async open(targetUri?: vscode.Uri): Promise<void> {
		const uri = await this.resolveTargetUri(targetUri);
		if (!uri) {
			return;
		}

		await this.loadDocument(uri, true);
	}

	async refresh(): Promise<void> {
		if (!this.session) {
			return;
		}

		await this.loadDocument(this.session.uri, false);
	}

	async editValue(target?: ConfigNode): Promise<void> {
		if (!this.session) {
			void vscode.window.showWarningMessage('No config loaded. Use "Open Config (Tree)" first.');
			return;
		}

		if (!target) {
			void vscode.window.showWarningMessage('Run this command from a Config Editor tree item.');
			return;
		}

		if (!this.isLeaf(target.value)) {
			void vscode.window.showWarningMessage('Only value nodes can be edited.');
			return;
		}

		const newValue = await this.promptForValue(target);
		if (newValue === undefined) {
			return;
		}

		if (!this.applyValue(target.segments, newValue)) {
			void vscode.window.showErrorMessage('Failed to update value.');
			return;
		}

		await this.persistChanges();
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	async chooseSchema(): Promise<void> {
		if (!this.session) {
			void vscode.window.showWarningMessage('Open a config file before selecting a schema.');
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
			void vscode.window.showInformationMessage('Schema mapping cleared. Automatic detection restored.');
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
		void vscode.window.showInformationMessage('Schema attached to current config.');
	}

	private async loadDocument(uri: vscode.Uri, showNotification: boolean): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');
			const parsed = JSON.parse(text);
			const schema = await this.loadSchema(uri);
			this.session = { uri, data: parsed, schema };
			this.watchConfig(uri);
			this.watchSchema(schema);
			this.onDidChangeTreeDataEmitter.fire(undefined);
			if (showNotification) {
				const suffix = schema ? ` with schema ${path.basename(schema.uri.fsPath)}` : '';
				void vscode.window.showInformationMessage(`Loaded ${path.basename(uri.fsPath)}${suffix}.`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Failed to load config: ${getErrorMessage(error)}`);
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
			void vscode.window.showWarningMessage('Config file was deleted.');
			this.onDidChangeTreeDataEmitter.fire(undefined);
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
			this.onDidChangeTreeDataEmitter.fire(undefined);
		};

		this.schemaWatcher.onDidChange(reload);
		this.schemaWatcher.onDidCreate(reload);
		this.schemaWatcher.onDidDelete(() => {
			if (!this.session) {
				return;
			}

			this.session.schema = undefined;
			this.onDidChangeTreeDataEmitter.fire(undefined);
		});
	}

	private buildChildren(value: unknown, parentPath: PathSegment[]): ConfigNode[] {
		const nodes: ConfigNode[] = [];
		if (value === null || value === undefined) {
			return nodes;
		}

		if (Array.isArray(value)) {
			value.forEach((child, index) => {
				const node = this.createNode({
					key: `[${index}]`,
					parentPath,
					segment: index,
					value: child
				});
				if (node) {
					nodes.push(node);
				}
			});
			return nodes;
		}

		if (typeof value === 'object') {
			for (const key of Object.keys(value as Record<string, unknown>)) {
				const child = (value as Record<string, unknown>)[key];
				const node = this.createNode({
					key,
					parentPath,
					segment: key,
					value: child
				});
				if (node) {
					nodes.push(node);
				}
			}
		}

		return nodes;
	}

	private createNode(params: {
		key: string;
		value: unknown;
		parentPath: PathSegment[];
		segment: PathSegment;
	}): ConfigNode | undefined {
		const segments = [...params.parentPath, params.segment];
		const pathKey = buildPathKey(segments);
		if (!this.isVisible(pathKey)) {
			return undefined;
		}

		const schemaEntry = this.session?.schema?.getField(pathKey);
		const isLeaf = this.isLeaf(params.value);
		const label = schemaEntry?.label ?? params.key;
		const description = isLeaf ? this.formatValue(params.value) : undefined;
		const tooltip = this.buildTooltip(label, schemaEntry, pathKey, params.value);

		return new ConfigNode(params.key, params.value, segments, {
			label,
			description,
			collapsibleState: isLeaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
			contextValue: isLeaf ? 'configValue' : 'configContainer',
			schema: schemaEntry,
			tooltip
		});
	}

	private buildTooltip(
		label: string,
		schemaEntry: SchemaFieldDefinition | undefined,
		pathKey: string,
		value: unknown
	): string {
		const details: string[] = [];
		details.push(label);
		details.push(`Path: ${pathKey || '(root)'}`);
		details.push(`Value: ${this.formatValue(value)}`);
		if (schemaEntry?.description) {
			details.push(schemaEntry.description);
		}

		return details.join('\n');
	}

	private isLeaf(value: unknown): boolean {
		if (value === null) {
			return true;
		}

		return typeof value !== 'object';
	}

	private isVisible(pathKey: string): boolean {
		if (!this.session?.schema) {
			return true;
		}

		return this.session.schema.isVisible(pathKey);
	}

	private formatValue(value: unknown): string {
		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		if (value === null) {
			return 'null';
		}

		return Array.isArray(value) ? `[${value.length}]` : '{…}';
	}

	private async resolveTargetUri(targetUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
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

	private async promptForValue(node: ConfigNode): Promise<unknown | undefined> {
		const schemaEntry = node.schema;
		const type = schemaEntry?.type ?? inferSchemaType(node.value);
		const range = schemaEntry?.range;
		const enumValues = schemaEntry?.enum ?? range?.options;
		const options: EditOptions = { type, range, enumValues };

		if (options.enumValues && options.enumValues.length > 0) {
			const pick = await vscode.window.showQuickPick(
				options.enumValues.map((item) => ({
					label: String(item),
					value: item
				})),
				{ placeHolder: 'Select value' }
			);

			return pick?.value;
		}

		const valueAsString = this.valueToString(node.value);
		const input = await vscode.window.showInputBox({
			prompt: `Update ${buildPathKey(node.segments)}`,
			value: valueAsString,
			validateInput: (text) => this.validateValue(text, options)
		});

		if (input === undefined) {
			return undefined;
		}

		return this.castValue(input, options.type);
	}

	private validateValue(value: string, options: EditOptions): string | undefined {
		if (options.enumValues && options.enumValues.length > 0) {
			return options.enumValues.includes(value) ? undefined : 'Value must be one of the allowed options.';
		}

		if (options.type === 'integer') {
			const parsed = Number.parseInt(value, 10);
			if (Number.isNaN(parsed)) {
				return 'Enter a valid integer.';
			}

			return this.validateRange(parsed, options.range);
		}

		if (options.type === 'number') {
			const parsed = Number.parseFloat(value);
			if (Number.isNaN(parsed)) {
				return 'Enter a valid number.';
			}

			return this.validateRange(parsed, options.range);
		}

		if (options.type === 'boolean') {
			if (!['true', 'false'].includes(value.toLowerCase())) {
				return 'Enter true or false.';
			}
		}

		return undefined;
	}

	private validateRange(value: number, range?: SchemaRange): string | undefined {
		if (!range) {
			return undefined;
		}

		if (typeof range.min === 'number' && value < range.min) {
			return `Value must be >= ${range.min}.`;
		}

		if (typeof range.max === 'number' && value > range.max) {
			return `Value must be <= ${range.max}.`;
		}

		return undefined;
	}

	private castValue(value: string, type: SchemaValueType): unknown {
		switch (type) {
			case 'integer':
				return Number.parseInt(value, 10);
			case 'number':
				return Number.parseFloat(value);
			case 'boolean':
				return value.toLowerCase() === 'true';
			default:
				return value;
		}
	}

	private valueToString(value: unknown): string {
		if (value === undefined || value === null) {
			return '';
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		return JSON.stringify(value);
	}

	private applyValue(pathSegments: PathSegment[], newValue: unknown): boolean {
		if (!this.session) {
			return false;
		}

		if (pathSegments.length === 0) {
			this.session.data = newValue;
			return true;
		}

		return setValueAtPath(this.session.data, pathSegments, newValue);
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
