import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
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
	type: 'ready' | 'editValue' | 'reload' | 'selectSchema' | 'save' | 'editSchema' | 'arrayAction' | 'mutateArray';
	path?: string;
	value?: unknown;
	valueType?: SchemaValueType;
	updates?: SchemaEditPayload;
	mutation?: ArrayMutationPayload;
	arrayKind?: ArrayMutationPayload['kind'];
}

interface SchemaEditPayload {
	visible?: 'inherit' | 'visible' | 'hidden';
	label?: string | null;
	description?: string | null;
	type?: string | null;
	unit?: string | null;
	enum?: Array<string | number> | null;
	rangeMin?: number | null;
	rangeMax?: number | null;
	rangeOptions?: Array<string | number> | null;
}

interface ArrayMutationPayload {
	kind: 'add' | 'remove' | 'clone';
	index?: number;
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
				case 'editSchema':
					if (message.path && message.updates) {
						void this.updateSchemaEntry(message.path, message.updates);
					}
					break;
				case 'arrayAction':
					if (message.path && message.arrayKind) {
						void this.handleArrayAction(message.path, message.arrayKind);
					}
					break;
				case 'mutateArray':
					if (message.path && message.mutation) {
						void this.mutateArray(message.path, message.mutation);
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
				{ label: 'Browse for schema file...', value: 'pick' },
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

	private async updateSchemaEntry(pathKey: string, updates: SchemaEditPayload): Promise<void> {
		if (!this.session || !this.session.schema) {
			this.postStatus('error', 'No schema attached.');
			return;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(this.session.schema.uri);
			const text = Buffer.from(bytes).toString('utf8');
			const document = JSON.parse(text) as Record<string, unknown>;
			const existing = this.session.schema.getField(pathKey);
			const schemaPath = existing?.schemaPath ?? deriveSchemaPath(pathKey, document);
			const target = schemaPath ? resolveSchemaTarget(document, schemaPath) : undefined;
			if (!target) {
				this.postStatus('error', 'Failed to locate schema entry.');
				return;
			}

			applySchemaUpdates(target, updates);
			const configuration = vscode.workspace.getConfiguration('configEditor');
			const indent = Math.max(0, configuration.get<number>('indentSize', 2));
			const updated = JSON.stringify(document, null, indent) + '\n';
			await vscode.workspace.fs.writeFile(this.session.schema.uri, Buffer.from(updated, 'utf8'));
			this.session.schema = await readSchemaFile(this.session.schema.uri);
			this.syncState();
		} catch (error) {
			this.postStatus('error', `Failed to update schema: ${getErrorMessage(error)}`);
		}
	}

	private async mutateArray(pathKey: string, mutation: ArrayMutationPayload): Promise<void> {
		if (!this.session) {
			return;
		}

		const segments = parsePathKey(pathKey);
		const target = segments.length === 0 ? this.session.data : getValueAtPath(this.session.data, segments);
		if (!Array.isArray(target)) {
			this.postStatus('error', 'Selected node is not an array.');
			return;
		}

		const working = [...target];
		const resolvedIndex = this.normalizeArrayIndex(mutation.kind, working.length, mutation.index);
		if (resolvedIndex === undefined) {
			this.postStatus('error', 'Invalid index for array operation.');
			return;
		}

		let insertedValue: unknown = undefined;
		if (mutation.kind === 'add') {
			if (mutation.valueType) {
				insertedValue = this.castValue(mutation.value, mutation.valueType);
				if (insertedValue === undefined) {
					this.postStatus('error', 'Failed to cast value for insertion.');
					return;
				}
			} else {
				insertedValue = mutation.value;
			}

			if (insertedValue === undefined) {
				insertedValue = null;
			}

			working.splice(resolvedIndex, 0, insertedValue);
		} else if (mutation.kind === 'remove') {
			if (working.length === 0) {
				this.postStatus('error', 'Array is empty.');
				return;
			}
			working.splice(resolvedIndex, 1);
		} else if (mutation.kind === 'clone') {
			if (working.length === 0) {
				this.postStatus('error', 'Array is empty.');
				return;
			}
			const sourceIdx = Math.min(Math.max(0, resolvedIndex), working.length - 1);
			const cloneSource = working[sourceIdx];
			insertedValue = this.deepClone(cloneSource);
			working.splice(sourceIdx + 1, 0, insertedValue);
		}

		if (segments.length === 0) {
			this.session.data = working;
		} else {
			if (!setValueAtPath(this.session.data, segments, working)) {
				this.postStatus('error', 'Failed to apply array change.');
				return;
			}
		}

		const affectedPath = pathKey || '';
		this.modifiedPaths.add(affectedPath);
		this.syncState();
		this.postStatus('info', 'Array updated (unsaved).');
	}

	private normalizeArrayIndex(kind: ArrayMutationPayload['kind'], length: number, index?: number): number | undefined {
		if (length < 0) {
			return undefined;
		}
		const maxAdd = length;
		const maxExisting = Math.max(0, length - 1);
		if (index === undefined || Number.isNaN(index)) {
			return kind === 'add' ? length : maxExisting;
		}
		const clamped = Math.max(0, Math.trunc(index));
		if (kind === 'add') {
			return clamped > maxAdd ? maxAdd : clamped;
		}
		return clamped > maxExisting ? maxExisting : clamped;
	}

	private deepClone<T>(value: T): T {
		try {
			return JSON.parse(JSON.stringify(value)) as T;
		} catch {
			return value;
		}
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

	private async handleArrayAction(pathKey: string, kind: ArrayMutationPayload['kind']): Promise<void> {
		if (!this.session) {
			return;
		}

		const segments = parsePathKey(pathKey);
		const target = segments.length === 0 ? this.session.data : getValueAtPath(this.session.data, segments);
		if (!Array.isArray(target)) {
			this.postStatus('error', 'Selected node is not an array.');
			return;
		}

		const length = target.length;
		const schemaEntry = this.session.schema?.getField(pathKey ? `${pathKey}[0]` : '[0]');

		const index = await this.promptArrayIndex(kind, length);
		if (index === undefined) {
			return;
		}

		if (kind === 'remove' || kind === 'clone') {
			await this.mutateArray(pathKey, { kind, index });
			return;
		}

		const picked = await this.promptArrayValue(schemaEntry);
		if (!picked) {
			return;
		}

		await this.mutateArray(pathKey, {
			kind: 'add',
			index,
			value: picked.value,
			valueType: picked.valueType
		});
	}

	private async promptArrayIndex(
		kind: ArrayMutationPayload['kind'],
		length: number
	): Promise<number | undefined> {
		const defaultIndex = kind === 'add' ? length : Math.max(0, length - 1);
		const maxIndex = kind === 'add' ? length : Math.max(0, length - 1);
		const input = await vscode.window.showInputBox({
			title: kind === 'add' ? 'Insert index (0-based)' : 'Target index (0-based)',
			value: String(defaultIndex),
			validateInput: (text) => {
				const parsed = Number.parseInt(text, 10);
				if (Number.isNaN(parsed) || parsed < 0) {
					return 'Enter a non-negative integer.';
				}
				if (parsed > maxIndex) {
					return `Index must be <= ${maxIndex}.`;
				}

				return undefined;
			}
		});

		if (input === undefined) {
			return undefined;
		}

		const parsed = Number.parseInt(input, 10);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	private async promptArrayValue(
		schemaEntry: SchemaFieldDefinition | undefined
	): Promise<{ value: unknown; valueType: SchemaValueType | undefined } | undefined> {
		const options = schemaEntry?.enum ?? schemaEntry?.range?.options;
		if (options && options.length > 0) {
			const pick = await vscode.window.showQuickPick(
				options.map((entry) => ({
					label: String(entry),
					value: entry
				})),
				{ placeHolder: 'Select value' }
			);

			if (!pick) {
				return undefined;
			}

			return { value: pick.value, valueType: this.inferValueTypeFromLiteral(pick.value) };
		}

		const normalizedType = this.normalizeSchemaType(schemaEntry?.type ?? schemaEntry?.rawType ?? 'string');
		if (normalizedType === 'boolean') {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'true', value: true },
					{ label: 'false', value: false }
				],
				{ placeHolder: 'Select boolean value' }
			);
			if (!pick) {
				return undefined;
			}
			return { value: pick.value, valueType: 'boolean' };
		}

		if (normalizedType === 'integer' || normalizedType === 'number') {
			const input = await vscode.window.showInputBox({
				title: normalizedType === 'integer' ? 'Enter integer value' : 'Enter number value',
				validateInput: (text) => {
					const parsed = normalizedType === 'integer' ? Number.parseInt(text, 10) : Number.parseFloat(text);
					return Number.isNaN(parsed) ? 'Enter a valid number.' : undefined;
				}
			});
			if (input === undefined) {
				return undefined;
			}
			const parsed = normalizedType === 'integer' ? Number.parseInt(input, 10) : Number.parseFloat(input);
			return { value: parsed, valueType: normalizedType };
		}

		// string or schema-less types
		if (schemaEntry) {
			const input = await vscode.window.showInputBox({ title: 'Enter value', value: '' });
			if (input === undefined) {
				return undefined;
			}
			return { value: input, valueType: 'string' };
		}

		const typePick = await vscode.window.showQuickPick(
			[
				{ label: 'string', value: 'string' as const },
				{ label: 'number', value: 'number' as const },
				{ label: 'integer', value: 'integer' as const },
				{ label: 'boolean', value: 'boolean' as const },
				{ label: 'object', value: 'object' as const },
				{ label: 'array', value: 'array' as const },
				{ label: 'null', value: 'null' as const }
			],
			{ placeHolder: 'Select value type' }
		);
		if (!typePick) {
			return undefined;
		}

		switch (typePick.value) {
			case 'boolean': {
				const pick = await vscode.window.showQuickPick(
					[
						{ label: 'true', value: true },
						{ label: 'false', value: false }
					],
					{ placeHolder: 'Select boolean value' }
				);
				if (!pick) {
					return undefined;
				}
				return { value: pick.value, valueType: 'boolean' };
			}
			case 'number':
			case 'integer': {
				const input = await vscode.window.showInputBox({
					title: typePick.value === 'integer' ? 'Enter integer value' : 'Enter number value',
					value: typePick.value === 'integer' ? '0' : '',
					validateInput: (text) => {
						const parsed = typePick.value === 'integer' ? Number.parseInt(text, 10) : Number.parseFloat(text);
						return Number.isNaN(parsed) ? 'Enter a valid number.' : undefined;
					}
				});
				if (input === undefined) {
					return undefined;
				}
				const parsed = typePick.value === 'integer' ? Number.parseInt(input, 10) : Number.parseFloat(input);
				return { value: parsed, valueType: typePick.value };
			}
			case 'object': {
				const input = await vscode.window.showInputBox({
					title: 'Enter JSON object',
					value: '{}',
					validateInput: (text) => {
						try {
							const parsed = JSON.parse(text.trim().length === 0 ? '{}' : text);
							return typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null
								? undefined
								: 'Enter a JSON object (e.g., {"key":"value"}).';
						} catch {
							return 'Enter valid JSON.';
						}
					}
				});
				if (input === undefined) {
					return undefined;
				}
				try {
					const parsed = JSON.parse(input.trim().length === 0 ? '{}' : input);
					return { value: parsed, valueType: undefined };
				} catch {
					return undefined;
				}
			}
			case 'array': {
				const input = await vscode.window.showInputBox({
					title: 'Enter JSON array',
					value: '[]',
					validateInput: (text) => {
						try {
							const parsed = JSON.parse(text.trim().length === 0 ? '[]' : text);
							return Array.isArray(parsed) ? undefined : 'Enter a JSON array (e.g., [1,2]).';
						} catch {
							return 'Enter valid JSON.';
						}
					}
				});
				if (input === undefined) {
					return undefined;
				}
				try {
					const parsed = JSON.parse(input.trim().length === 0 ? '[]' : input);
					return { value: parsed, valueType: undefined };
				} catch {
					return undefined;
				}
			}
			case 'null':
				return { value: null, valueType: undefined };
			default: {
				const input = await vscode.window.showInputBox({ title: 'Enter value', value: '' });
				if (input === undefined) {
					return undefined;
				}
				return { value: input, valueType: 'string' };
			}
		}
	}

	private normalizeSchemaType(type: string | undefined): SchemaValueType | 'object' | 'array' | 'null' {
		const lowered = (type ?? '').trim().toLowerCase();
		if (['integer', 'number', 'boolean', 'string'].includes(lowered)) {
			return lowered as SchemaValueType;
		}
		if (lowered === 'float' || lowered === 'double' || lowered === 'decimal') {
			return 'number';
		}
		if (lowered === 'enum') {
			return 'string';
		}
		if (lowered === 'object') {
			return 'object';
		}
		if (lowered === 'array') {
			return 'array';
		}
		if (lowered === 'null') {
			return 'null';
		}
		return 'string';
	}

	private inferValueTypeFromLiteral(value: unknown): SchemaValueType | undefined {
		if (typeof value === 'boolean') {
			return 'boolean';
		}
		if (typeof value === 'number') {
			return Number.isInteger(value) ? 'integer' : 'number';
		}
		if (typeof value === 'string') {
			return 'string';
		}
		return undefined;
	}

	private async loadDocument(uri: vscode.Uri, notify: boolean): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');
			const parsed = parseJsonc(text);
			const schema = await this.loadSchema(uri);
			this.session = { uri, data: parsed, schema };
			this.originalData = parseJsonc(text);
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
		const extensionCandidates = [extension];
		if (!extensionCandidates.includes('.json')) {
			extensionCandidates.push('.json');
		}
		const defaultSchemaPaths = extensionCandidates.map((ext) => path.join(pathInfo.dir, `${pathInfo.name}${suffix}${ext}`));
		const stored = this.workspaceState.get<string>(schemaMappingKey(configUri.fsPath));

		const candidates: vscode.Uri[] = [];
		if (stored) {
			candidates.push(vscode.Uri.file(stored));
		}

		for (const schemaPath of defaultSchemaPaths) {
			candidates.push(vscode.Uri.file(schemaPath));
		}

		for (const location of resolveAdditionalSchemaLocations()) {
			for (const ext of extensionCandidates) {
				const candidate = vscode.Uri.file(path.join(location.fsPath, `${pathInfo.name}${suffix}${ext}`));
				candidates.push(candidate);
			}
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
		return /* html */ String.raw`<!DOCTYPE html>
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
		.search-group {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			flex: 1;
			min-width: 0;
		}
		.search-box {
			flex: 1;
			min-width: 0;
			display: flex;
			align-items: stretch;
			border: 1px solid var(--vscode-input-border, #555);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 3px;
			overflow: hidden;
			height: 28px;
		}
		.search-input {
			flex: 1;
			padding: 0 0.55rem;
			border: none;
			background: transparent;
			color: inherit;
			outline: none;
			min-width: 0;
			font: inherit;
			line-height: 1.35;
		}
		.search-input.search-error {
			outline: 1px solid var(--vscode-inputValidation-errorBorder, #e51400);
			box-shadow: 0 0 0 1px var(--vscode-inputValidation-errorBorder, #e51400);
		}
		.search-box:focus-within {
			border-color: var(--vscode-focusBorder, var(--vscode-input-border, #555));
			box-shadow: 0 0 0 1px var(--vscode-focusBorder, transparent);
		}
		.search-toggles {
			display: inline-flex;
			align-items: stretch;
			border-left: 1px solid var(--vscode-input-border, #555);
			background: var(--vscode-input-background);
			height: 100%;
		}
		.search-toggle {
			border: 1px solid transparent;
			padding: 0 0.55rem;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			cursor: pointer;
			min-width: 32px;
			border-left: 1px solid var(--vscode-input-border, #555);
			font: inherit;
			outline: none;
			box-shadow: none;
			border-radius: 0;
			transition: background 0.08s ease, border-color 0.08s ease, box-shadow 0.08s ease;
		}
		.search-toggle:first-child {
			border-left-color: transparent;
		}
		.search-toggle:hover {
			background: var(--vscode-input-hoverBackground, rgba(255, 255, 255, 0.04));
		}
		.search-toggle.active {
			background: var(--vscode-inputOption-activeBackground, #0e639c);
			color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
			border-color: var(--vscode-inputOption-activeBorder, #89d185);
			box-shadow: 0 0 0 1px var(--vscode-inputOption-activeBorder, #89d185) inset;
			border-radius: 2px;
		}
		.search-toggle.active:not(:first-child) {
			border-left-color: var(--vscode-inputOption-activeBorder, #89d185);
		}
		.search-toggle:focus-visible {
			outline: 1px solid var(--vscode-focusBorder, #89d185);
			outline-offset: -1px;
		}
		.search-toggle:not(.active) {
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			border-color: var(--vscode-input-border, #555);
		}
		.search-toggle .underline {
			position: relative;
			display: inline-block;
			padding: 0 2px 3px;
			text-decoration: none;
			line-height: 1.05;
		}
		.search-toggle .underline::after {
			content: '';
			position: absolute;
			left: -2px;
			right: -2px;
			bottom: -1px;
			height: 8px;
			border: 1.6px solid currentColor;
			border-top: 0;
			border-radius: 0 0 6px 6px;
			pointer-events: none;
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
			grid-template-columns: 1fr 380px;
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
		.schema-editor {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			padding: 0.6rem;
			background: var(--vscode-editor-selectionBackground, rgba(255, 255, 255, 0.04));
			margin-top: 0.6rem;
		}
		.schema-editor-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 0.5rem;
			gap: 0.5rem;
		}
		.schema-editor-header strong {
			display: block;
		}
		.schema-editor-actions {
			display: flex;
			gap: 0.4rem;
		}
		.schema-editor-actions button {
			padding: 0.25rem 0.6rem;
		}
		.toolbar-row .toolbar-actions {
			display: flex;
			align-items: center;
			gap: 0.25rem;
			justify-content: flex-start;
			flex-wrap: nowrap;
			flex-shrink: 1;
		}
		.toolbar-row .toolbar-actions button {
			padding: 0.28rem 0.6rem;
			min-width: 56px;
		}
		.schema-toolbar-visible {
			display: block !important;
		}
		.schema-mode-toggle {
			white-space: nowrap;
		}
		.schema-grid {
			display: grid;
			grid-template-columns: 140px 1fr;
			gap: 0.4rem 0.6rem;
			align-items: center;
		}
		.schema-grid label {
			font-size: 0.8rem;
			color: var(--vscode-descriptionForeground);
		}
		.schema-grid textarea {
			min-height: 2.5rem;
		}
		.schema-note {
			font-size: 0.75rem;
			color: var(--vscode-descriptionForeground);
			margin-top: 0.4rem;
		}
		.array-actions {
			display: flex;
			gap: 0.4rem;
			flex-wrap: wrap;
		}
		.array-help {
			font-size: 0.85rem;
			color: var(--vscode-descriptionForeground);
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
		.schema-mode-toggle {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.9rem;
			color: var(--vscode-descriptionForeground);
			user-select: none;
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<div class="search-group">
			<div class="search-box">
				<input id="searchBox" class="search-input" type="text" placeholder="Search key or value..." />
				<div class="search-toggles" role="group" aria-label="Search options">
					<button id="caseToggle" class="search-toggle" type="button" title="Match Case">Aa</button>
					<button id="wordToggle" class="search-toggle" type="button" title="Match Whole Word"><span class="underline">ab</span></button>
					<button id="regexToggle" class="search-toggle" type="button" title="Use Regular Expression">.*</button>
				</div>
			</div>
		</div>
		<button id="reloadBtn" title="Reload file">Reload</button>
		<button id="saveFileBtn" title="Save changes to disk">Save</button>
		<button id="schemaBtn" title="Select schema file">Select Schema</button>
	</div>
	<div class="layout">
		<div class="tree-container">
			<div id="tree" class="tree empty-state">No config loaded.</div>
		</div>
		<div class="details">
			<div class="detail-row toolbar-row" id="schemaToolbar" style="display:none;">
				<div class="toolbar-actions">
					<button id="schemaSaveBtn" type="button">Save</button>
					<button id="schemaCancelBtn" type="button">Close</button>
					<label class="schema-mode-toggle">
						<input id="schemaModeToggle" type="checkbox" />
						Schema edit
					</label>
				</div>
			</div>
			<div class="detail-row">
				<label>Selected Key</label>
				<div id="selectedKey">Select a node from the tree.</div>
			</div>
			<div id="valueEditor" style="display:none;">
				<div class="detail-row" id="valueRow">
					<label id="valueLabel">Value</label>
					<div id="valueControls"></div>
				</div>
				<div class="detail-row" id="descriptionRow">
					<label>Description</label>
					<div id="valueDescription">-</div>
				</div>
				<div class="detail-row" id="rangeRow" style="display:none;">
					<label>Range</label>
					<div id="rangeText">-</div>
				</div>
				<div class="schema-editor detail-row" id="schemaEditor" style="display:none;">
					<div class="schema-editor-header">
						<div>
							<strong>Schema Editor</strong>
							<div id="schemaEditorKey"></div>
						</div>
					</div>
					<div class="schema-grid">
						<label for="schemaVisible">Visibility</label>
						<select id="schemaVisible">
							<option value="">Inherit</option>
							<option value="visible">Visible</option>
							<option value="hidden">Hidden</option>
						</select>
						<label for="schemaLabel">Label</label>
						<input id="schemaLabel" type="text" />
						<label for="schemaDescription">Description</label>
						<textarea id="schemaDescription"></textarea>
						<label for="schemaType" class="schema-advanced">Type</label>
						<input id="schemaType" type="text" class="schema-advanced" placeholder="string, enum, integer, number, boolean, float..." />
						<label for="schemaUnit" class="schema-advanced">Unit</label>
						<input id="schemaUnit" type="text" class="schema-advanced" />
						<label for="schemaEnum" class="schema-advanced">Enum Values</label>
						<textarea id="schemaEnum" class="schema-advanced" placeholder="Comma or newline separated values"></textarea>
						<label for="schemaRangeMin" class="schema-advanced">Range Min</label>
						<input id="schemaRangeMin" class="schema-advanced" type="number" />
						<label for="schemaRangeMax" class="schema-advanced">Range Max</label>
						<input id="schemaRangeMax" class="schema-advanced" type="number" />
						<label for="schemaRangeOptions" class="schema-advanced">Range Options</label>
						<textarea id="schemaRangeOptions" class="schema-advanced" placeholder="Comma or newline separated values"></textarea>
					</div>
					<div class="schema-note">For object nodes you can change visibility, label, and description.</div>
				</div>
			</div>
			<div id="arrayEditor" style="display:none;">
				<div class="detail-row">
					<div class="array-help" id="arrayHelp">Select an array node or element to manage items.</div>
				</div>
				<div class="detail-row">
					<label for="arrayIndexInput">Index</label>
					<input id="arrayIndexInput" type="number" min="0" step="1" />
				</div>
				<div class="detail-row" id="arrayEnumRow" style="display:none;">
					<label for="arrayEnumSelect">Value (enum/options)</label>
					<select id="arrayEnumSelect"></select>
				</div>
				<div class="detail-row" id="arrayTypeRow" style="display:none;">
					<label for="arrayTypeSelect">Value type</label>
					<select id="arrayTypeSelect">
						<option value="string">string</option>
						<option value="number">number</option>
						<option value="integer">integer</option>
						<option value="boolean">boolean</option>
						<option value="object">object</option>
						<option value="array">array</option>
						<option value="null">null</option>
					</select>
				</div>
				<div class="detail-row" id="arrayValueRow" style="display:none;">
					<label for="arrayValueInput">Value</label>
					<input id="arrayValueInput" type="text" />
					<select id="arrayBoolSelect" style="display:none;">
						<option value="true">true</option>
						<option value="false">false</option>
					</select>
					<textarea id="arrayJsonInput" style="display:none;" rows="3"></textarea>
					<div id="arrayValueHint" class="array-help">Select a type, then enter the value. Objects/arrays should be JSON.</div>
					<div class="array-actions" style="margin-top:0.4rem;">
						<button id="arrayAddBtn" type="button">Add item</button>
						<button id="arrayRemoveBtn" type="button">Remove item</button>
					</div>
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
			const caseToggle = document.getElementById('caseToggle');
			const wordToggle = document.getElementById('wordToggle');
			const regexToggle = document.getElementById('regexToggle');
			const selectedKey = document.getElementById('selectedKey');
			const detailsPanel = document.querySelector('.details');
			const valueEditor = document.getElementById('valueEditor');
			const valueControls = document.getElementById('valueControls');
			const valueRow = document.getElementById('valueRow');
			const valueDescription = document.getElementById('valueDescription');
			const descriptionRow = document.getElementById('descriptionRow');
			const rangeRow = document.getElementById('rangeRow');
			const rangeText = document.getElementById('rangeText');
			const schemaEditor = document.getElementById('schemaEditor');
			const schemaEditorKey = document.getElementById('schemaEditorKey');
			const schemaVisible = document.getElementById('schemaVisible');
			const schemaLabelInput = document.getElementById('schemaLabel');
			const schemaDescriptionInput = document.getElementById('schemaDescription');
			const schemaTypeInput = document.getElementById('schemaType');
			const schemaUnitInput = document.getElementById('schemaUnit');
			const schemaEnumInput = document.getElementById('schemaEnum');
			const schemaRangeMinInput = document.getElementById('schemaRangeMin');
			const schemaRangeMaxInput = document.getElementById('schemaRangeMax');
			const schemaRangeOptionsInput = document.getElementById('schemaRangeOptions');
			const arrayEditor = document.getElementById('arrayEditor');
			const arrayAddBtn = document.getElementById('arrayAddBtn');
			const arrayRemoveBtn = document.getElementById('arrayRemoveBtn');
			const arrayHelp = document.getElementById('arrayHelp');
			const arrayIndexInput = document.getElementById('arrayIndexInput');
			const arrayEnumRow = document.getElementById('arrayEnumRow');
			const arrayEnumSelect = document.getElementById('arrayEnumSelect');
			const arrayTypeRow = document.getElementById('arrayTypeRow');
			const arrayTypeSelect = document.getElementById('arrayTypeSelect');
			const arrayValueRow = document.getElementById('arrayValueRow');
			const arrayValueInput = document.getElementById('arrayValueInput');
			const arrayBoolSelect = document.getElementById('arrayBoolSelect');
			const arrayJsonInput = document.getElementById('arrayJsonInput');
			const arrayValueHint = document.getElementById('arrayValueHint');
			const statusNode = document.getElementById('status');
			const saveFileBtn = document.getElementById('saveFileBtn');
			const schemaSaveBtn = document.getElementById('schemaSaveBtn');
			const schemaCancelBtn = document.getElementById('schemaCancelBtn');
			const schemaModeToggle = document.getElementById('schemaModeToggle');
			const schemaToolbar = document.getElementById('schemaToolbar');
			let viewState = typeof vscode.getState === 'function' ? vscode.getState() || {} : {};
			let data = undefined;
			let schema = {};
			let currentSelection = null;
			let modifiedPaths = new Set();
			let schemaFilePath = null;
			let schemaModeActive = false;
			let schemaModePath = null;
			let schemaLimitedMode = false;
			let schemaEditMode = !!viewState.schemaEditMode;
			let searchState = {
				matchCase: !!viewState.searchMatchCase,
				wholeWord: !!viewState.searchWholeWord,
				useRegex: !!viewState.searchUseRegex
			};
			const schemaModeToggleInput = schemaModeToggle;
			const branchControls = new Map();
			const collapsedPaths = new Set();
			const labelPathCache = new Map();
			function updateViewState(patch) {
				viewState = { ...viewState, ...patch };
				if (typeof vscode.setState === 'function') {
					vscode.setState(viewState);
				}
			}
			function hasSchemaUi() {
				return (
					schemaEditor &&
					schemaEditorKey &&
					schemaVisible &&
					schemaLabelInput &&
					schemaDescriptionInput &&
					schemaTypeInput &&
					schemaUnitInput &&
					schemaEnumInput &&
					schemaRangeMinInput &&
					schemaRangeMaxInput &&
					schemaRangeOptionsInput
				);
			}

			function persistSearchState() {
				updateViewState({
					searchMatchCase: searchState.matchCase,
					searchWholeWord: searchState.wholeWord,
					searchUseRegex: searchState.useRegex
				});
			}

			function initializeSearchToggle(button, key) {
				if (!button) {
					return;
				}
				const refresh = () => {
					button.classList.toggle('active', !!searchState[key]);
					button.setAttribute('aria-pressed', searchState[key] ? 'true' : 'false');
				};
				refresh();
				button.addEventListener('click', () => {
					searchState[key] = !searchState[key];
					persistSearchState();
					refresh();
					renderTree(searchBox.value);
				});
			}

			initializeSearchToggle(caseToggle, 'matchCase');
			initializeSearchToggle(wordToggle, 'wholeWord');
			initializeSearchToggle(regexToggle, 'useRegex');

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
			if (schemaSaveBtn) {
				schemaSaveBtn.addEventListener('click', () => {
					if (!schemaModeActive || !schemaModePath) {
						return;
					}
					const updates = collectSchemaUpdates();
					if (!updates) {
						setStatusError('Schema editor UI not available.');
						return;
					}
					vscode.postMessage({ type: 'editSchema', path: schemaModePath, updates });
					exitSchemaEditor();
				});
			}
			if (schemaCancelBtn) {
				schemaCancelBtn.addEventListener('click', () => {
					exitSchemaEditor();
				});
			}
			if (schemaModeToggleInput) {
				schemaModeToggleInput.checked = schemaEditMode;
				if (schemaCancelBtn instanceof HTMLButtonElement) {
					schemaCancelBtn.disabled = schemaEditMode;
				}
				schemaModeToggleInput.addEventListener('change', () => {
					const checked = schemaModeToggleInput.checked;
					schemaEditMode = checked;
					updateViewState({ schemaEditMode });
					if (schemaCancelBtn instanceof HTMLButtonElement) {
						schemaCancelBtn.disabled = schemaEditMode;
					}
					renderTree(searchBox.value);
					if (currentSelection) {
						selectPath(currentSelection.pathKey);
					}
					if (schemaEditMode && currentSelection) {
						enterSchemaEditor(currentSelection.pathKey);
					} else {
						exitSchemaEditor(false);
					}
				});
			}
			if (valueEditor) {
				valueEditor.addEventListener('dblclick', (event) => {
					if (!event.ctrlKey || !currentSelection || valueEditor.style.display === 'none' || schemaModeActive) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					const pathKey = currentSelection.pathKey || '';
					if (!schemaFilePath) {
						setStatusError('No schema attached.');
						return;
					}
					enterSchemaEditor(pathKey);
				});
			}
			if (detailsPanel) {
				detailsPanel.addEventListener('dblclick', (event) => {
					if (!currentSelection || schemaModeActive) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					if (!event.ctrlKey) {
						return;
					}
					const pathKey = currentSelection.pathKey || '';
					if (!schemaFilePath) {
						setStatusError('No schema attached.');
						return;
					}
					enterSchemaEditor(pathKey);
				});
			}
			treeContainer.addEventListener('dblclick', (event) => {
				const targetElement = event.target;
				const button = targetElement && typeof targetElement.closest === 'function' ? targetElement.closest('.node-label') : null;
				if (!button) {
					return;
				}
				if (!event.ctrlKey) {
					return;
				}
				const pathKey = button.dataset.path || '';
				selectPath(pathKey);
				if (!schemaFilePath) {
					setStatusError('No schema attached.');
					return;
				}
				enterSchemaEditor(pathKey);
			});

			if (arrayAddBtn) {
				arrayAddBtn.addEventListener('click', () => {
					handleArraySubmit('add');
				});
			}
			if (arrayRemoveBtn) {
				arrayRemoveBtn.addEventListener('click', () => {
					handleArraySubmit('remove');
				});
			}

			searchBox.addEventListener('input', () => {
				renderTree(searchBox.value);
			});

			window.addEventListener('message', (event) => {
				const msg = event.data;
				if (msg.type === 'init') {
					data = msg.payload.data;
					schema = msg.payload.schema || {};
					labelPathCache.clear();
					schemaFilePath = msg.payload.schemaFile || null;
			if (schemaModeToggleInput) {
				schemaModeToggleInput.checked = schemaEditMode;
			}
					if (!schemaFilePath) {
						exitSchemaEditor(false);
					} else if (schemaModeActive && schemaModePath) {
						const entry = schema[schemaModePath];
						if (entry) {
							populateSchemaEditor(entry);
						} else {
							exitSchemaEditor(false);
						}
					}
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

				const filterSpec = compileFilter(filterText);
				const filter = filterSpec && !filterSpec.hasError ? filterSpec : null;
				treeContainer.innerHTML = '';
				treeContainer.classList.remove('empty-state');
				const root = document.createElement('ul');
				buildNodes(data, [], root, filter, false);
				treeContainer.appendChild(root);
				if (currentSelection) {
					highlightSelection(currentSelection.pathKey);
				}
			}

			function buildNodes(value, segments, parent, filter, forceIncludeDescendants) {
				let added = false;
				const shouldShowChildren = !!forceIncludeDescendants;
				if (Array.isArray(value)) {
					value.forEach((entry, index) => {
						const childSegments = [...segments, index];
						const pathKey = buildPathKey(childSegments);
						if (!isVisibleNode(pathKey, entry, childSegments)) {
							return;
						}
						const rawKey = '[' + index + ']';
						const displayLabel = rawKey;
						const textValue = formatValue(entry);
						const schemaEntry = schema[pathKey];
						const nodeMatches = matchesFilter(
							{ displayLabel, rawKey, textValue, pathKey, schemaEntry, segments: childSegments },
							filter
						);
						if (isContainer(entry)) {
							const nestedList = document.createElement('ul');
							const childAdded = buildNodes(
								entry,
								childSegments,
								nestedList,
								shouldShowChildren || nodeMatches ? null : filter,
								shouldShowChildren || nodeMatches
							);
							if (!filter || nodeMatches || childAdded || shouldShowChildren) {
								appendNode(rawKey, entry, childSegments, parent, filter, pathKey, displayLabel, nestedList, nodeMatches);
								added = true;
							}
						} else {
							if (!filter || nodeMatches || shouldShowChildren) {
								appendNode(rawKey, entry, childSegments, parent, filter, pathKey, displayLabel, null, nodeMatches);
								added = true;
							}
						}
					});
					return added;
				}

				if (value && typeof value === 'object') {
					Object.keys(value).forEach((key) => {
						const childSegments = [...segments, key];
						const pathKey = buildPathKey(childSegments);
						if (!isVisibleNode(pathKey, value[key], childSegments)) {
							return;
						}
						const schemaEntry = schema[pathKey];
						const displayLabel = !schemaEditMode && schemaEntry?.label ? schemaEntry.label : key;
						const textValue = formatValue(value[key]);
						const nodeMatches = matchesFilter(
							{ displayLabel: displayLabel || key, rawKey: key, textValue, pathKey, schemaEntry, segments: childSegments },
							filter
						);
						const childValue = value[key];
						if (isContainer(childValue)) {
							const nestedList = document.createElement('ul');
							const childAdded = buildNodes(
								childValue,
								childSegments,
								nestedList,
								shouldShowChildren || nodeMatches ? null : filter,
								shouldShowChildren || nodeMatches
							);
							if (!filter || nodeMatches || childAdded || shouldShowChildren) {
								appendNode(key, childValue, childSegments, parent, filter, pathKey, displayLabel, nestedList, nodeMatches);
								added = true;
							}
						} else {
							if (!filter || nodeMatches || shouldShowChildren) {
								appendNode(key, childValue, childSegments, parent, filter, pathKey, displayLabel, null, nodeMatches);
								added = true;
							}
						}
					});
				}

				return added;
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
				entry.toggle.textContent = collapsed ? '+' : '-';
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

			function appendNode(label, value, segments, parent, filter, pathKey, displayLabel, nestedList, nodeMatches) {
				const li = document.createElement('li');
				const header = document.createElement('div');
				header.className = 'node-header';
				const isBranch = isContainer(value);
				let childList = nestedList;

				if (isBranch) {
					const toggle = document.createElement('button');
					toggle.className = 'toggle';
					toggle.type = 'button';
					toggle.textContent = '-';
					header.appendChild(toggle);
					if (!childList) {
						childList = document.createElement('ul');
					}
					registerBranchControl(pathKey, toggle, childList);
					toggle.addEventListener('click', (event) => {
						event.stopPropagation();
						toggleBranchState(pathKey);
					});
				} else {
					const spacer = document.createElement('span');
					spacer.className = 'toggle spacer';
					header.appendChild(spacer);
				}

				const button = createNodeButton(label, displayLabel, value, pathKey, !!filter, nodeMatches, isBranch);
				header.appendChild(button);
				li.appendChild(header);

				if (isBranch && childList) {
					li.appendChild(childList);
				}

				parent.appendChild(li);
			}

			function createNodeButton(rawKey, displayLabel, value, pathKey, hasFilter, nodeMatches, isBranch) {
				const button = document.createElement('button');
				button.className = 'node-label';
				button.type = 'button';
				button.dataset.path = pathKey || '';
				button.dataset.branch = String(isBranch);
				const textValue = isBranch ? '' : formatValue(value);
				if (hasFilter && !nodeMatches) {
					button.classList.add('dim');
				}
				const labelText = displayLabel || rawKey;
				button.textContent = !isBranch && textValue ? labelText + ': ' + textValue : labelText;
				button.addEventListener('click', () => {
					selectNode(pathKey, value, rawKey);
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
				exitSchemaEditor(false);
				currentSelection = { pathKey, key, value };
				selectedKey.textContent = pathKey || '(root)';
				if (schemaEditMode) {
					enterSchemaEditor(pathKey);
				} else {
					renderValueEditor(value, pathKey);
				}
			}

			function selectPath(pathKey) {
				exitSchemaEditor(false);
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
					if (schemaEditMode) {
						enterSchemaEditor(pathKey);
					} else {
						renderValueEditor(current, pathKey);
					}
					highlightSelection(pathKey);
				}
			}

			function renderValueEditor(value, pathKey) {
				const arrayContext = getArrayContextForElement(pathKey, value);
				if (arrayContext) {
					renderArrayEditor(arrayContext.arrayValue, arrayContext.arrayPath, arrayContext.index);
					return;
				}

				if (Array.isArray(value)) {
					renderArrayEditor(value, pathKey);
					return;
				}

				if (arrayEditor) {
					arrayEditor.style.display = 'none';
				}

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
				setupEditorCommit(editor, pathKey, type, schemaEntry);
			}

			function renderArrayEditor(value, pathKey, selectedIndex) {
				if (!arrayEditor) {
					return;
				}
				arrayEditor.style.display = 'block';
				if (valueEditor) {
					valueEditor.style.display = 'none';
				}
				selectedKey.textContent = pathKey || '(root)';
				if (arrayHelp) {
					arrayHelp.textContent = 'Length: ' + value.length + '.';
				}
				arrayEditor.dataset.path = pathKey || '';
				const currentValue = typeof selectedIndex === 'number' ? value[selectedIndex] : undefined;
				setupArrayInputs(value, pathKey, selectedIndex, currentValue);
				if (arrayRemoveBtn) {
					arrayRemoveBtn.style.display = typeof selectedIndex === 'number' ? '' : 'none';
				}
			}

			function setupArrayInputs(value, pathKey, selectedIndex, currentValue) {
				if (
					!arrayIndexInput ||
					!arrayTypeSelect ||
					!arrayValueInput ||
					!arrayBoolSelect ||
					!arrayJsonInput ||
					!arrayValueRow ||
					!arrayTypeRow
				) {
					return;
				}
				const defaultIndex = selectedIndex !== undefined ? selectedIndex : value.length;
				arrayIndexInput.value = String(defaultIndex);
				arrayIndexInput.max = String(Math.max(0, value.length));

				const itemSchema = getArrayItemSchema(pathKey);
				const options = itemSchema?.enum || (itemSchema?.range && itemSchema.range.options);
				const normalizedType = normalizeSchemaTypeLocal(itemSchema?.type || itemSchema?.rawType || 'string');

				if (options && Array.isArray(options) && options.length > 0 && arrayEnumRow && arrayEnumSelect) {
					arrayEnumRow.style.display = '';
					arrayEnumSelect.innerHTML = '';
					options.forEach((opt) => {
						const option = document.createElement('option');
						option.value = String(opt);
						option.textContent = String(opt);
						arrayEnumSelect.appendChild(option);
					});
					arrayTypeRow.style.display = 'none';
					arrayValueRow.style.display = 'none';
				} else {
					if (arrayEnumRow) {
						arrayEnumRow.style.display = 'none';
					}
					if (arrayTypeRow) {
						arrayTypeRow.style.display = '';
					}
					if (arrayValueRow) {
						arrayValueRow.style.display = '';
					}

					const deduced = deduceTypeForValue(currentValue) ?? normalizedType;
					arrayTypeSelect.value = deduced;
					showArrayValueInputs(deduced, currentValue);
				}
			}

			function showArrayValueInputs(type, currentValue) {
				if (!arrayValueInput || !arrayBoolSelect || !arrayJsonInput) {
					return;
				}
				arrayValueInput.style.display = 'none';
				arrayBoolSelect.style.display = 'none';
				arrayJsonInput.style.display = 'none';
				updateArrayHint(type);
				if (type === 'boolean') {
					arrayBoolSelect.style.display = '';
					if (currentValue !== undefined) {
						arrayBoolSelect.value = String(Boolean(currentValue));
					}
				} else if (type === 'object' || type === 'array') {
					arrayJsonInput.style.display = '';
					if (currentValue !== undefined) {
						try {
							arrayJsonInput.value = JSON.stringify(currentValue, null, 2);
						} catch {
							arrayJsonInput.value = type === 'object' ? '{}' : '[]';
						}
					} else {
						arrayJsonInput.value = type === 'object' ? '{}' : '[]';
					}
				} else if (type === 'null') {
					// no input
				} else {
					arrayValueInput.style.display = '';
					arrayValueInput.type = type === 'number' || type === 'integer' ? 'number' : 'text';
					if (currentValue !== undefined && currentValue !== null) {
						arrayValueInput.value = String(currentValue);
					} else {
						arrayValueInput.value = '';
					}
				}
			}

			if (arrayTypeSelect) {
				arrayTypeSelect.addEventListener('change', () => {
					clearStatus();
					showArrayValueInputs(arrayTypeSelect.value, undefined);
				});
			}

			function collectArrayValue(pathKey, kind) {
				const itemSchema = getArrayItemSchema(pathKey);
				const options = itemSchema?.enum || (itemSchema?.range && itemSchema.range.options);
				if (options && arrayEnumRow && arrayEnumRow.style.display !== 'none' && arrayEnumSelect) {
					const val = arrayEnumSelect.value;
					return { value: val, valueType: inferTypeFromLiteral(val) };
				}

				const type = arrayTypeSelect ? arrayTypeSelect.value : 'string';
				if (type === 'null') {
					return { value: null, valueType: undefined };
				}
				if (type === 'boolean') {
					return { value: arrayBoolSelect?.value === 'true', valueType: 'boolean' };
				}
				if (type === 'integer' || type === 'number') {
					const raw = arrayValueInput?.value ?? '';
					const parsed = type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
					if (Number.isNaN(parsed)) {
						setStatusError('Enter a valid number.');
						return undefined;
					}
					return { value: parsed, valueType: type };
				}
				if (type === 'object' || type === 'array') {
					const raw = arrayJsonInput?.value ?? '';
					try {
						const parsed = JSON.parse(raw.trim().length === 0 ? (type === 'object' ? '{}' : '[]') : raw);
						if (type === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null)) {
							setStatusError('Enter a JSON object.');
							return undefined;
						}
						if (type === 'array' && !Array.isArray(parsed)) {
							setStatusError('Enter a JSON array.');
							return undefined;
						}
						return { value: parsed, valueType: undefined };
					} catch {
						setStatusError('Enter valid JSON.');
						return undefined;
					}
				}

				const raw = arrayValueInput?.value ?? '';
				return { value: raw, valueType: 'string' };
			}

			function deduceTypeForValue(val) {
				if (val === null) {
					return 'null';
				}
				if (typeof val === 'boolean') {
					return 'boolean';
				}
				if (typeof val === 'number') {
					return Number.isInteger(val) ? 'integer' : 'number';
				}
				if (Array.isArray(val)) {
					return 'array';
				}
				if (val && typeof val === 'object') {
					return 'object';
				}
				return 'string';
			}

			function updateArrayHint(type) {
				if (!arrayValueHint) {
					return;
				}
				const base = {
					string: 'Enter plain text.',
					number: 'Enter a number (decimal ok).',
					integer: 'Enter an integer.',
					boolean: 'Select true/false.',
					object: 'Enter JSON object, e.g., {"id":"H","name":"Example"}.',
					array: 'Enter JSON array, e.g., [{"id":"H"}].',
					null: 'Value will be null.'
				};
				arrayValueHint.textContent = base[type] || 'Select a type, then enter the value.';
			}

			function clearStatus() {
				if (statusNode) {
					statusNode.textContent = '';
					statusNode.className = 'status';
				}
			}

			function handleArraySubmit(kind) {
				if (!arrayEditor) {
					return;
				}
				const pathKey = arrayEditor.dataset.path || '';
				const index = arrayIndexInput ? Number.parseInt(arrayIndexInput.value || '0', 10) : NaN;
				if (Number.isNaN(index) || index < 0) {
					setStatusError('Enter a valid index.');
					return;
				}

				if (kind === 'add') {
					const collected = collectArrayValue(pathKey, kind);
					if (!collected) {
						return;
					}
					vscode.postMessage({
						type: 'mutateArray',
						path: pathKey,
						mutation: { kind: 'add', index, value: collected.value, valueType: collected.valueType }
					});
				} else if (kind === 'remove') {
					vscode.postMessage({
						type: 'mutateArray',
						path: pathKey,
						mutation: { kind, index }
					});
				}
			}

			function getArrayContextForElement(pathKey, value) {
				const segments = parsePathKey(pathKey);
				if (segments.length === 0) {
					return null;
				}
				const last = segments[segments.length - 1];
				if (typeof last !== 'number') {
					return null;
				}
				const parentSegments = segments.slice(0, -1);
				const parentPath = buildPathKey(parentSegments);
				const parentValue = getValueForPath(parentPath);
				if (!Array.isArray(parentValue)) {
					return null;
				}
				return { arrayPath: parentPath, arrayValue: parentValue, index: last };
			}

			function getArrayItemSchema(pathKey) {
				const base = pathKey || '';
				const candidate = base.length > 0 ? base + '[0]' : '[0]';
				return schema[candidate];
			}

			function inferTypeFromLiteral(value) {
				if (value === null || value === undefined) {
					return undefined;
				}
				if (value === 'true' || value === 'false') {
					return 'boolean';
				}
				if (typeof value === 'number') {
					return Number.isInteger(value) ? 'integer' : 'number';
				}
				return 'string';
			}

			function normalizeSchemaTypeLocal(type) {
				const lowered = String(type || '').toLowerCase();
				if (['integer', 'number', 'boolean', 'string'].includes(lowered)) {
					return lowered;
				}
				if (lowered === 'float' || lowered === 'double' || lowered === 'decimal') {
					return 'number';
				}
				if (lowered === 'enum') {
					return 'string';
				}
				if (lowered === 'object') {
					return 'object';
				}
				if (lowered === 'array') {
					return 'array';
				}
				if (lowered === 'null') {
					return 'null';
				}
				return 'string';
			}

			// prompt helpers removed; prompts handled in extension host to avoid sandbox modal restrictions.

			function getValueForPath(pathKey) {
				const segments = parsePathKey(pathKey);
				let current = data;
				for (const segment of segments) {
					if (current === undefined || current === null) {
						return undefined;
					}
					current = typeof segment === 'number' ? current[segment] : current[segment];
				}
				return current;
			}

			function setSchemaAdvancedVisible(show) {
				document.querySelectorAll('.schema-advanced').forEach((element) => {
					if (element instanceof HTMLElement) {
						element.style.display = show ? '' : 'none';
					}
				});
			}

			function enterSchemaEditor(pathKey) {
				if (!hasSchemaUi()) {
					setStatusError('Schema editor UI not available.');
					return;
				}
				const entry = schema[pathKey || ''] || {};
				const isContainerNode = currentSelection ? isContainer(currentSelection.value) : isContainer(getValueForPath(pathKey));
				schemaLimitedMode = isContainerNode;
				if (valueEditor) {
					valueEditor.style.display = 'block';
				}
				if (schemaLimitedMode && valueRow) {
					valueRow.style.display = 'none';
				}
				if (schemaCancelBtn instanceof HTMLButtonElement) {
					schemaCancelBtn.disabled = schemaEditMode;
				}
				if (schemaToolbar) {
					schemaToolbar.classList.add('schema-toolbar-visible');
				}
				setSchemaAdvancedVisible(!schemaLimitedMode);
				schemaModeActive = true;
				schemaModePath = pathKey || '';
				schemaEditor.dataset.path = schemaModePath;
				schemaEditorKey.textContent = schemaModePath || '(root)';
				if (descriptionRow) {
					descriptionRow.style.display = 'none';
				}
				if (rangeRow) {
					rangeRow.style.display = 'none';
				}
				schemaEditor.style.display = 'block';
				populateSchemaEditor(entry);
				if (schemaModeToggleInput) {
					schemaModeToggleInput.checked = schemaEditMode;
				}
			}

			function exitSchemaEditor(shouldRerender = true) {
				if (!schemaModeActive) {
					return;
				}
				if (!schemaEditor) {
					schemaModeActive = false;
					schemaModePath = null;
					return;
				}
				schemaModeActive = false;
				schemaModePath = null;
				schemaEditor.style.display = 'none';
				schemaEditor.dataset.path = '';
				if (valueEditor && currentSelection && isContainer(currentSelection.value)) {
					valueEditor.style.display = 'none';
				}
				if (schemaToolbar && !schemaEditMode) {
					schemaToolbar.classList.remove('schema-toolbar-visible');
				}
				if (valueRow) {
					valueRow.style.display = '';
				}
				if (descriptionRow) {
					descriptionRow.style.display = '';
				}
				if (shouldRerender && currentSelection) {
					renderValueEditor(currentSelection.value, currentSelection.pathKey);
				}
			}

			function populateSchemaEditor(entry) {
				if (!hasSchemaUi()) {
					return;
				}
				schemaVisible.value = entry.visible === undefined ? '' : entry.visible ? 'visible' : 'hidden';
				schemaLabelInput.value = entry.label || '';
				schemaDescriptionInput.value = entry.description || '';
				schemaTypeInput.value = entry.rawType || entry.type || '';
				schemaUnitInput.value = entry.unit || '';
				schemaEnumInput.value = formatSchemaList(entry.enum);
				if (entry.range) {
					schemaRangeMinInput.value = typeof entry.range.min === 'number' ? String(entry.range.min) : '';
					schemaRangeMaxInput.value = typeof entry.range.max === 'number' ? String(entry.range.max) : '';
					schemaRangeOptionsInput.value = formatSchemaList(entry.range.options);
				} else {
					schemaRangeMinInput.value = '';
					schemaRangeMaxInput.value = '';
					schemaRangeOptionsInput.value = '';
				}
			}

			function formatSchemaList(values) {
				if (!Array.isArray(values) || values.length === 0) {
					return '';
				}
				return values.map((entry) => String(entry)).join('\n');
			}

			function collectSchemaUpdates() {
				if (!hasSchemaUi()) {
					return undefined;
				}
				const enumValues = parseSchemaList(schemaEnumInput.value);
				const rangeOptions = parseSchemaList(schemaRangeOptionsInput.value);
				const base = {
					visible: schemaVisible.value || 'inherit',
					label: normalizeSchemaString(schemaLabelInput.value),
					description: normalizeSchemaString(schemaDescriptionInput.value)
				};
				if (schemaLimitedMode) {
					return base;
				}

				return {
					...base,
					type: normalizeSchemaString(schemaTypeInput.value),
					unit: normalizeSchemaString(schemaUnitInput.value),
					enum: enumValues.length > 0 ? enumValues : null,
					rangeMin: parseNumberValue(schemaRangeMinInput.value),
					rangeMax: parseNumberValue(schemaRangeMaxInput.value),
					rangeOptions: rangeOptions.length > 0 ? rangeOptions : null
				};
			}

			function normalizeSchemaString(value) {
				const trimmed = typeof value === 'string' ? value.trim() : '';
				return trimmed.length > 0 ? trimmed : null;
			}

			function parseSchemaList(raw) {
				return raw
					.split(/[\n,]/)
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0)
					.map((entry) => toSchemaValue(entry));
			}

			function toSchemaValue(entry) {
				if (/^-?\d+(?:\.\d+)?$/.test(entry)) {
					const parsed = Number(entry);
					if (!Number.isNaN(parsed)) {
						return parsed;
					}
				}
				return entry;
			}

			function parseNumberValue(value) {
				if (value === undefined || value === null) {
					return null;
				}
				const trimmed = String(value).trim();
				if (trimmed.length === 0) {
					return null;
				}
				const parsed = Number(trimmed);
				return Number.isNaN(parsed) ? null : parsed;
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

			function compileFilter(rawText) {
				if (searchBox) {
					searchBox.classList.remove('search-error');
					searchBox.removeAttribute('title');
				}
				const raw = typeof rawText === 'string' ? rawText.trim() : '';
				if (!raw) {
					return null;
				}
				const flags = searchState.matchCase ? '' : 'i';
				const wholeWord = searchState.wholeWord;
				try {
					if (searchState.useRegex) {
						const pattern = wholeWord ? wrapWithWordBoundaries(raw) : raw;
						return {
							raw,
							regex: new RegExp(pattern, flags),
							pathRegex: buildPathSearchRegex(raw, true, searchState.matchCase),
							hasError: false
						};
					}
					const escaped = escapeForRegex(raw);
					// Avoid nested template literals inside the HTML string.
					const pattern = wholeWord ? '\\b' + escaped + '\\b' : escaped;
					return {
						raw,
						regex: new RegExp(pattern, flags),
						// In literal mode, avoid pathRegex to prevent regex semantics on paths; rely on escaped regex above.
						pathRegex: undefined,
						hasError: false
					};
				} catch (error) {
					if (searchBox) {
						searchBox.classList.add('search-error');
						searchBox.title = 'Invalid regular expression';
					}
					return { hasError: true };
				}
			}

			function matchesFilter(context, filter) {
				if (!filter || filter.hasError) {
					return true;
				}
				const { rawKey, displayLabel, textValue, pathKey, schemaEntry, segments } = context;
				if (filter.pathRegex) {
					if (filter.pathRegex.test(pathKey || '')) {
						return true;
					}
					const labelPath = getLabelPathFromSegments(segments);
					if (labelPath && filter.pathRegex.test(labelPath)) {
						return true;
					}
				}
				if (!filter.regex) {
					return true;
				}
				const candidates = [
					rawKey,
					pathKey,
					displayLabel,
					schemaEntry?.label,
					schemaEntry?.description,
					textValue
				].filter(Boolean);
				for (const entry of candidates) {
					if (filter.regex.test(String(entry))) {
						return true;
					}
				}
				return false;
			}

			function escapeForRegex(value) {
				// Escape regex control characters; backslash keeps the dollar brace literal.
				return value.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
			}

			function buildPathSearchRegex(raw, isRegex, matchCase) {
				const segments = derivePathSegments(raw, isRegex);
				if (!segments || segments.length === 0) {
					return undefined;
				}
				if (isRegex) {
					try {
						return new RegExp(segments.join('\\.'), matchCase ? '' : 'i');
					} catch (error) {
						return undefined;
					}
				}

				// Literal search: match only at segment boundaries to avoid partial hits like ".dir" matching "direct".
				const escapedSegments = segments.map((segment) => escapeForRegex(segment)).join('\\.');
				const boundedPattern = '(?:^|\\.)' + escapedSegments + '(?:\\.|$)';
				try {
					return new RegExp(boundedPattern, matchCase ? '' : 'i');
				} catch (error) {
					return undefined;
				}
			}

			function derivePathSegments(raw, isRegex) {
				if (!raw) {
					return undefined;
				}
				if (isRegex) {
					const separator = /\\\./;
					if (!separator.test(raw)) {
						return undefined;
					}
					const parts = raw.split(separator).filter((part) => part.length > 0);
					return parts.length > 0 ? parts : undefined;
				}

				// Literal search: split on unescaped dots only so "\." stays literal.
				const parts = [];
				let buffer = '';
				let escaped = false;
				for (let i = 0; i < raw.length; i++) {
					const ch = raw[i];
					if (escaped) {
						buffer += ch;
						escaped = false;
						continue;
					}
					if (ch === '\\') {
						escaped = true;
						buffer += ch;
						continue;
					}
					if (ch === '.') {
						if (buffer.length > 0) {
							parts.push(buffer);
						}
						buffer = '';
						continue;
					}
					buffer += ch;
				}
				if (buffer.length > 0) {
					parts.push(buffer);
				}
				return parts.length > 0 ? parts : undefined;
			}

			function getLabelPathFromSegments(segments) {
				if (!segments || segments.length === 0) {
					return '';
				}
				const cacheKey = buildPathKey(segments);
				if (labelPathCache.has(cacheKey)) {
					return labelPathCache.get(cacheKey);
				}
				const accumulated = [];
				const labels = [];
				for (const segment of segments) {
					accumulated.push(segment);
					const pathKey = buildPathKey(accumulated);
					const entry = schema[pathKey];
					if (entry?.label) {
						labels.push(entry.label);
					} else if (typeof segment === 'number') {
						labels.push('[' + segment + ']');
					} else {
						labels.push(String(segment));
					}
				}
				const value = labels.join('.');
				labelPathCache.set(cacheKey, value);
				return value;
			}

			function wrapWithWordBoundaries(pattern) {
				return '\\b(?:' + pattern + ')\\b';
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

			function isVisibleNode(pathKey, nodeValue, segments) {
				return isVisibleNodeInternal(pathKey, nodeValue, segments);
			}

			function isVisibleNodeInternal(pathKey, nodeValue, segments) {
				if (schemaEditMode) {
					return true;
				}
				const entry = schema[pathKey];
				if (entry && entry.visible === false) {
					return false;
				}
				const value = nodeValue;
				const isContainerNode = value && typeof value === 'object';
				if (!isContainerNode) {
					return true;
				}
				const baseSegments = segments ?? parsePathKey(pathKey);
				return hasVisibleDescendant(value, baseSegments);
			}

			function hasVisibleDescendant(value, segments) {
				if (value === null || value === undefined) {
					return false;
				}
				if (Array.isArray(value)) {
					for (let i = 0; i < value.length; i++) {
						const childSegments = [...segments, i];
						const childPath = buildPathKey(childSegments);
						if (isVisibleNodeInternal(childPath, value[i], childSegments)) {
							return true;
						}
					}
					return false;
				}
				if (typeof value === 'object') {
					for (const key of Object.keys(value)) {
						const childSegments = [...segments, key];
						const childPath = buildPathKey(childSegments);
						if (isVisibleNodeInternal(childPath, value[key], childSegments)) {
							return true;
						}
					}
				}
				return false;
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

function resolveSchemaTarget(root: Record<string, unknown>, schemaPath: string[]): Record<string, unknown> | undefined {
	let current: unknown = root;
	for (const segment of schemaPath) {
		if (Array.isArray(current)) {
			const index = Number.parseInt(segment, 10);
			if (Number.isNaN(index)) {
				return undefined;
			}

			const array = current as unknown[];
			if (!array[index] || typeof array[index] !== 'object' || array[index] === null) {
				array[index] = {};
			}
			current = array[index];
			continue;
		}

		if (!current || typeof current !== 'object') {
			return undefined;
		}

		const container = current as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(container, segment) || typeof container[segment] !== 'object' || container[segment] === null) {
			container[segment] = {};
		}
		current = container[segment];
	}

	return current && typeof current === 'object' ? (current as Record<string, unknown>) : undefined;
}

function applySchemaUpdates(target: Record<string, unknown>, updates: SchemaEditPayload): void {
	if ('visible' in updates) {
		delete target['visible'];
		delete target['visibility'];
		if (updates.visible === 'visible') {
			target['visibility'] = 'visible';
		} else if (updates.visible === 'hidden') {
			target['visibility'] = 'hidden';
		}
	}

	if ('label' in updates) {
		setSchemaString(target, 'label', updates.label);
	}

	if ('description' in updates) {
		setSchemaString(target, 'description', updates.description);
	}

	if ('type' in updates) {
		setSchemaString(target, 'type', updates.type);
	}

	if ('unit' in updates) {
		setSchemaString(target, 'unit', updates.unit);
	}

	if ('enum' in updates) {
		setSchemaArray(target, 'enum', updates.enum);
	}

	if ('rangeMin' in updates || 'rangeMax' in updates || 'rangeOptions' in updates) {
		const range: Record<string, unknown> = {};
		if (typeof updates.rangeMin === 'number') {
			range.min = updates.rangeMin;
		}
		if (typeof updates.rangeMax === 'number') {
			range.max = updates.rangeMax;
		}
		if (updates.rangeOptions && updates.rangeOptions.length > 0) {
			range.options = updates.rangeOptions;
		}

		if (Object.keys(range).length > 0) {
			target['range'] = range;
		} else {
			delete target['range'];
		}
	}
}

function setSchemaString(target: Record<string, unknown>, key: string, value: string | null | undefined): void {
	if (typeof value === 'string' && value.trim().length > 0) {
		target[key] = value.trim();
	} else {
		delete target[key];
	}
}

function setSchemaArray(target: Record<string, unknown>, key: string, value: Array<string | number> | null | undefined): void {
	if (Array.isArray(value) && value.length > 0) {
		target[key] = value;
	} else {
		delete target[key];
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

function deriveSchemaPath(pathKey: string, document: Record<string, unknown>): string[] {
	const baseSegments = parsePathKey(pathKey).map((segment) => String(segment));
	const fieldsValue = (document as Record<string, unknown>)['fields'];
	const hasFieldsContainer =
		fieldsValue !== undefined && fieldsValue !== null && (typeof fieldsValue === 'object' || Array.isArray(fieldsValue));
	return hasFieldsContainer ? ['fields', ...baseSegments] : baseSegments;
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
