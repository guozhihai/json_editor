import * as path from 'path';
import * as vscode from 'vscode';

export type SchemaValueType = 'string' | 'enum' | 'integer' | 'number' | 'boolean';

export interface SchemaRange {
	min?: number;
	max?: number;
	options?: Array<string | number>;
}

export interface SchemaFieldDefinition {
	visible?: boolean;
	label?: string;
	description?: string;
	type?: SchemaValueType;
	rawType?: string;
	schemaPath?: string[];
	enum?: Array<string | number>;
	range?: SchemaRange;
	unit?: string;
}

export interface ConfigSchemaDefinition {
	fields?: Record<string, unknown>;
	[path: string]: unknown;
}

export class ConfigSchema {
	constructor(
		public readonly uri: vscode.Uri,
		private readonly fields: Record<string, SchemaFieldDefinition>
	) {}

	getField(pathKey: string): SchemaFieldDefinition | undefined {
		return this.fields[pathKey];
	}

	getAll(): Record<string, SchemaFieldDefinition> {
		return { ...this.fields };
	}

	isVisible(pathKey: string): boolean {
		const entry = this.getField(pathKey);
		if (entry && entry.visible === false) {
			return false;
		}
		return true;
	}
}

export async function readSchemaFile(schemaUri: vscode.Uri): Promise<ConfigSchema | undefined> {
	try {
		const stat = await vscode.workspace.fs.stat(schemaUri);
		if (!stat) {
			return undefined;
		}
	} catch {
		return undefined;
	}

	try {
		const bytes = await vscode.workspace.fs.readFile(schemaUri);
		const text = Buffer.from(bytes).toString('utf8');
		const raw = JSON.parse(text) as ConfigSchemaDefinition;
		const normalized = normalizeSchema(raw);
		return new ConfigSchema(schemaUri, normalized);
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to parse schema ${schemaUri.fsPath}: ${getErrorMessage(error)}`);
		return undefined;
	}
}

function normalizeSchema(raw: ConfigSchemaDefinition): Record<string, SchemaFieldDefinition> {
	const result: Record<string, SchemaFieldDefinition> = {};

	if (raw && typeof raw === 'object') {
		const fields = typeof raw.fields === 'object' && raw.fields !== null ? (raw.fields as Record<string, unknown>) : undefined;
		if (fields) {
			flattenSchema(fields, [], result, ['fields']);
		}

		const remainder: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (key === 'fields') {
				continue;
			}
			remainder[key] = value;
		}
		flattenSchema(remainder, [], result, []);
	}

	return result;
}

function flattenSchema(
	source: Record<string, unknown>,
	segments: string[],
	target: Record<string, SchemaFieldDefinition>,
	rawSegments: string[]
): void {
	for (const [key, value] of Object.entries(source)) {
		if (!isPlainObject(value)) {
			continue;
		}

		const pathSegments = [...segments, key];
		const rawPath = [...rawSegments, key];
		const fieldDefinition = normalizeFieldObject(value);
		if (fieldDefinition) {
			fieldDefinition.schemaPath = rawPath;
			target[joinSegments(pathSegments)] = fieldDefinition;
			const nested = stripMetadataKeys(value);
			if (nested) {
				flattenSchema(nested, pathSegments, target, rawPath);
			}
			continue;
		}

		flattenSchema(value as Record<string, unknown>, pathSegments, target, rawPath);
	}
}

function normalizeFieldObject(value: Record<string, unknown>): SchemaFieldDefinition | undefined {
	const field: SchemaFieldDefinition = {};
	let defined = false;

	if (typeof value.visible === 'boolean') {
		field.visible = value.visible;
		defined = true;
	}

	if (typeof value.visibility === 'string') {
		const normalized = value.visibility.trim().toLowerCase();
		if (normalized === 'visible') {
			field.visible = true;
		} else if (normalized === 'invisible' || normalized === 'hidden' || normalized === 'false') {
			field.visible = false;
		}
		defined = true;
	}

	if (typeof value.label === 'string' && value.label.trim().length > 0) {
		field.label = value.label.trim();
		defined = true;
	}

	if (typeof value.title === 'string' && value.title.trim().length > 0 && !field.label) {
		field.label = value.title.trim();
		defined = true;
	}

	const description = pickFirstString(value.description, value.meaning, value.helpText, value.help);
	if (description) {
		field.description = description;
		defined = true;
	}

	if (typeof value.unit === 'string' && value.unit.trim().length > 0) {
		field.unit = value.unit.trim();
		defined = true;
	}

	const originalType = typeof value.type === 'string' ? value.type.trim().toLowerCase() : undefined;
	const normalizedType = normalizeType(value.type);
	if (normalizedType) {
		field.type = normalizedType;
		if (originalType) {
			field.rawType = originalType;
		}
		defined = true;
	}

	if (Array.isArray(value.enum)) {
		field.enum = value.enum as Array<string | number>;
		defined = true;
	}

	if (value.range !== undefined) {
		const range = normalizeRange(value.range, field.type);
		if (range) {
			field.range = range;
			if (!field.enum && field.type === 'enum' && range.options) {
				field.enum = range.options;
			}
			defined = true;
		}
	}

	return defined ? field : undefined;
}

function normalizeType(rawType: unknown): SchemaValueType | undefined {
	if (typeof rawType !== 'string' || rawType.trim().length === 0) {
		return undefined;
	}

	const value = rawType.trim().toLowerCase();
	if (value === 'string' || value === 'text') {
		return 'string';
	}

	if (value === 'enum' || value === 'select') {
		return 'enum';
	}

	if (value === 'integer' || value === 'int' || value === 'long' || value === 'short') {
		return 'integer';
	}

	if (value === 'float' || value === 'double' || value === 'number' || value === 'decimal') {
		return 'number';
	}

	if (value === 'boolean' || value === 'bool') {
		return 'boolean';
	}

	return undefined;
}

function normalizeRange(raw: unknown, type: SchemaValueType | undefined): SchemaRange | undefined {
	if (Array.isArray(raw)) {
		const options = raw as Array<string | number>;
		return options.length > 0
			? {
					options
			  }
			: undefined;
	}

	if (raw && typeof raw === 'object') {
		const source = raw as SchemaRange;
		const range: SchemaRange = {};
		if (typeof source.min === 'number') {
			range.min = source.min;
		}
		if (typeof source.max === 'number') {
			range.max = source.max;
		}
		if (Array.isArray(source.options)) {
			range.options = source.options;
		}
		return Object.keys(range).length > 0 ? range : undefined;
	}

	if (typeof raw === 'string' && raw.trim().length > 0) {
		const parsed = parseRangeString(raw);
		if (parsed) {
			return parsed;
		}

		const items = parseEnumString(raw);
		if (items.length > 0 && (type === 'enum' || items.length > 1)) {
			return { options: items };
		}
	}

	return undefined;
}

function parseRangeString(raw: string): SchemaRange | undefined {
	const match = raw.trim().match(/(-?\d+(?:\.\d+)?)\s*[-~]\s*(-?\d+(?:\.\d+)?)/);
	if (!match) {
		return undefined;
	}

	const min = Number.parseFloat(match[1]);
	const max = Number.parseFloat(match[2]);
	if (Number.isNaN(min) || Number.isNaN(max)) {
		return undefined;
	}

	return { min, max };
}

function stripMetadataKeys(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const nested: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (METADATA_KEYS.has(key)) {
			continue;
		}

		if (isPlainObject(entry)) {
			nested[key] = entry;
		}
	}

	return Object.keys(nested).length > 0 ? nested : undefined;
}

function pickFirstString(...candidates: unknown[]): string | undefined {
	for (const entry of candidates) {
		if (typeof entry === 'string' && entry.trim().length > 0) {
			return entry.trim();
		}
	}

	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinSegments(segments: string[]): string {
	if (segments.length === 0) {
		return '';
	}

	return segments
		.map((segment, index) => {
			if (/^\[\d+\]$/.test(segment)) {
				return index === 0 ? segment : segment;
			}

			if (/^\d+$/.test(segment)) {
				const formatted = `[${segment}]`;
				return index === 0 ? formatted : formatted;
			}

			return index === 0 ? segment : `.${segment}`;
		})
		.join('');
}

const METADATA_KEYS = new Set([
	'visible',
	'visibility',
	'label',
	'title',
	'description',
	'meaning',
	'help',
	'helpText',
	'type',
	'enum',
	'range',
	'unit'
]);

function parseEnumString(raw: string): string[] {
	return raw
		.split(/[|,;]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function schemaMappingKey(configPath: string): string {
	return `config-editor.schema::${configPath}`;
}

export function resolveAdditionalSchemaLocations(): vscode.Uri[] {
	const configuration = vscode.workspace.getConfiguration('configEditor');
	const locations = configuration.get<string[]>('schemaSearchPaths', []);
	const uris: vscode.Uri[] = [];

	for (const location of locations) {
		if (!location) {
			continue;
		}

		const resolved = resolvePath(location);
		if (resolved) {
			uris.push(resolved);
		}
	}

	return uris;
}

export function resolvePath(target: string): vscode.Uri | undefined {
	if (!target) {
		return undefined;
	}

	if (path.isAbsolute(target)) {
		return vscode.Uri.file(target);
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		return undefined;
	}

	return vscode.Uri.joinPath(workspaceFolder.uri, target);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
